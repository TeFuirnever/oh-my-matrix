# openclaw 长程任务自主执行机制调研

- **调研对象**：openclaw monorepo，本地路径 `/Users/guanxueliang/Desktop/Matrix/社区工程/openclaw`
- **HEAD**：`0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`（`fix(plugins): accept singleton npm view metadata`）
- **调研日期**：2026-09-18
- **方法**：源码优先。README / docs 的说法一律回源到 `src/` 验证。全程只读，未安装依赖、未执行 build/test。
- **证据档位**：
  - **源码** = 在 `src/` / `packages/` / `extensions/` 中读到实现，挂 `file:line`
  - **文档** = 仅 `docs/` 或 `*.md` 声明，源码中未找到对应实现（已注明查过哪些路径）
  - **未找到** = 既无源码也无文档，或文档声称但源码检索为空

---

## 一、6 维度现状表

### 维度 1：任务状态持久化

| 项 | 内容 |
| --- | --- |
| 机制 | **单一 SQLite 库 + 强 schema**。`openclaw-state-schema.sql` 共 **1362 行 / 71 张表**，长程执行相关的核心表是 `task_runs`、`subagent_runs`、`flow_runs`、`cron_jobs`、`cron_run_logs`、`delivery_queue_entries`、`commitments`、`state_leases`、`worktrees`。不是 JSON 文件，不是远端服务。 |
| `file:line` | `src/state/openclaw-state-schema.sql:1119`（`task_runs`）、`:1158`（`subagent_runs`，**43 列**）、`:1273`（`flow_runs`）、`:975`（`cron_jobs`，**~70 列**）、`:939`（`cron_run_logs`）、`:1084`（`delivery_queue_entries`）、`:897`（`commitments`）、`:112`（`state_leases`）、`:1343`（`worktrees`） |
| 证据 | **源码** |

关键设计点（都是源码读出来的）：

- **schema 是展开的列，不是一个 blob**。`cron_jobs` 把 `next_run_at_ms`、`running_at_ms`、`consecutive_errors`、`last_delivery_status` 等全部提成独立列并建了条件索引（`src/state/openclaw-state-schema.sql:1053` `idx_cron_jobs_enabled_next_run ... WHERE next_run_at_ms IS NOT NULL`），同时保留 `job_json` + `state_json` 两个逃生舱。查询走列，演进走 JSON。
- **跨进程重启能活**。`task_runs` / `flow_runs` / `cron_jobs` 都是磁盘表；进程内只有一层索引缓存（`src/tasks/task-registry.process-state.ts:18`，用 `Symbol.for("openclaw.taskRegistry.state")` 挂在 `globalThis` 上，重启即丢，靠从 SQLite 重建）。
- **`flow_runs` 有乐观并发控制**：`revision INTEGER NOT NULL DEFAULT 0`（`:1279`）。文档明确说明每次变更要带 expected revision，stale write 被拒而非覆盖（`docs/automation/taskflow.md` "Every mutation passes the flow's expected revision"）——这一条我在 `src/tasks/task-flow-registry.ts:67` 看到了 `revision: number` 字段定义，但没有逐行追到 CAS 比较点，**记为文档 + 部分源码**。
- **分布式互斥有独立原语**：`state_leases`（scope / lease_key / owner / expires_at / heartbeat_at），带过期索引和 owner 索引（`:112`-`:129`）。这是 lease 而非锁——有 `heartbeat_at`，说明设计上假设持有者会崩。

### 维度 2：中断恢复

| 项 | 内容 |
| --- | --- |
| 机制 | **三条独立恢复路径**，各管一段：① cron 启动扫尸（crash tombstone）② task registry 后台清扫（stale → 尝试恢复 → 标 `lost`）③ `on-exit` 调度类型（进程退出触发唤醒）。**没有"续跑上一个 turn"这回事** —— 中断的 turn 一律标失败，由调度层决定是否重跑。 |
| `file:line` | `src/cron/service/ops.ts:229`（`start()`）、`:137`（`markInterruptedStartupRun`）、`src/tasks/task-registry.maintenance.ts:1105`（`runTaskRegistryMaintenance`）、`:1136`（`tryRecoverTaskBeforeMarkLost`）、`src/gateway/cron-exit-watchers.ts:1-241`、`src/state/openclaw-state-schema.sql:582`（`gateway_restart_sentinel`）、`:604`（`gateway_restart_intent`）、`:615`（`gateway_restart_handoff`）、`:636`（`gateway_boot_lifecycle`） |
| 证据 | **源码** |

三条路径细节：

**① cron 启动扫尸。** 持久化的 `running_at_ms` 标记本身就是墓碑：进程若在 run 中途死掉，这个字段留在盘上。重启时 `start()` 遍历所有 job，凡 `typeof job.state.runningAtMs === "number"` 就调 `markInterruptedStartupRun` 把它改写成一次**普通的失败 run**（`lastRunStatus = "error"`、`lastError = STARTUP_INTERRUPTED_ERROR`、`consecutiveErrors += 1`、`nextRunAtMs = undefined`），注释写得很直白：

> `// A persisted running marker means the gateway stopped mid-run; mark it as a normal failed run so retries, alerts, and run logs all see one outcome.` —— `src/cron/service/ops.ts:144`

这是我认为最值得抄的形状之一：**把崩溃归一化成一次失败**，而不是发明一个 `interrupted` 状态让下游全部加分支。

**② task registry 清扫。** `runTaskRegistryMaintenance()` 按 `TASK_SWEEP_INTERVAL_MS = 60_000` 跑（`src/tasks/task-registry.maintenance.ts:77`），判据是三个常量：`TASK_RECONCILE_GRACE_MS = 5min`（`:74`）、`TASK_STALE_RUNNING_MS = 30min`（`:76`）、`CHILDLESS_NATIVE_SUBAGENT_RECONCILE_GRACE_MS = 30min`（`:75`）。流程是 stale 判定 → `tryRecoverTaskBeforeMarkLost` hook 给 runtime 一次抢救机会 → 抢救后**重新取一遍 fresh record 再判一次**（`:1140`-`:1155`，防 hook 副作用导致误判）→ 仍然该丢就 `markTaskLost`。清扫每 25 条 `await yieldToEventLoop()`（`SWEEP_YIELD_BATCH_SIZE = 25`，`:83`），避免大扫堵主线程。

**③ `on-exit` —— `DESIGN-cron-on-exit.md` 已落地，不是纸面设计。** 文件 `src/gateway/cron-exit-watchers.ts` 存在（8.1K / 241 行），CHANGELOG 有对应条目（`CHANGELOG.md:405` PR #92037 `feat(cron): on-exit schedule — wake on a watched command's exit`），schedule kind 全链路贯通：类型 `src/cron/types.ts:29`、`computeNextRunAtMs` 返回 `undefined` 使定时器永不触发 `src/cron/schedule.ts:80`、normalize `src/cron/normalize.ts:99`、SQLite 编解码 `src/cron/store/row-codec.ts:53`、启动时重新武装 `src/gateway/server-cron-lazy.ts:60`。

它解决的问题正是长程执行的一个硬约束：**CLI backend 每个 turn 是 supervisor 派生的 detached process group，turn 结束时被 `SIGTERM→SIGKILL` 整棵杀掉**（`DESIGN-cron-on-exit.md` 指向 `src/process/supervisor/adapters/child.ts`），所以 agent 自己 `exec &` 挂后台的进程必然随 turn 死。`on-exit` 的解法是把 watcher 放到 **gateway supervisor 树**下（`scopeKey: "cron-exit:<jobId>"`，`src/gateway/cron-exit-watchers.ts:38`），per-turn teardown 碰不到它。

两处 fail-closed 写得很硬，值得单独点名：

```
// 持久化先于触发：store 写失败就不唤醒
try { await params.persistCompletion(job.id); }
catch (err) { ... "cron-exit: persistCompletion failed; NOT firing (fail closed to avoid replay)" ; return; }
```
—— `src/gateway/cron-exit-watchers.ts:171-182`。理由是：若先唤醒后持久化，gateway 重启会重新武装并**二次执行同一条命令**。

```
// run.wait() reject（未知结局）→ 释放 slot 但不触发
catch (err) { ... "cron-exit: run.wait() rejected; released watcher slot without firing"; return; }
```
—— `:148-159`。

另外 `armToken` + 同步预留 slot 的做法处理了"spawn 在途中被 cancel/re-arm"的竞态：slot 在 `arm()` 里 **await 之前**就同步塞进 map（`:109-111`），`owns()` 做 identity 检查（`:111`），失去所有权的 in-flight child 会被 `run.cancel()` 掉而非泄漏（`:137-142`）。

**实现比设计文档多了一条**：`ON_EXIT_WATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000`（`:11`），24 小时安全上限，`DESIGN-cron-on-exit.md` 里没有这一项。注释说明了取这么宽的理由（on-exit 正当地用来盯 build/deploy 这类长命令），超时后按普通退出处理。

### 维度 3：完成判定

| 项 | 内容 |
| --- | --- |
| 机制 | **外部 gate 否决模型自述**。核心是一个正则组，专门识别"模型只说了在干活、没交付成果"的收尾文本，命中就把任务判为 `blocked` 而不是 `succeeded`。 |
| `file:line` | `src/tasks/task-completion-contract.ts:11`（`PROGRESS_ONLY_PATTERN`）、`:14`（`BARE_PROGRESS_ONLY_PATTERN`）、`:17`（`FOLLOW_UP_PLANNING_PREFIX_PATTERN`）、`:65`（`resolveRequiredCompletionTerminalResult`）、`:85`（delivery 失败变体） |
| 证据 | **源码** |

这个 module 是整个 repo 里我认为最 deep 的一个，95 行，无依赖（只 import 一个 utf16 截断工具），干一件事：**判断一段收尾文本是不是"假完成"**。

```js
const PROGRESS_ONLY_PATTERN =
  /^(?:i(?:'|’)ll|i will|i(?:'|’)m|i am|...)\s+(?:now\s+)?(?:analyz(?:e|ing)|apply|check(?:ing)?|continue|debug(?:ging)?|...|verify(?:ing)?|work(?:ing)?)/i;
```

三层判据：

1. `PROGRESS_ONLY_PATTERN` —— `"I'll now investigate…"` / `"Let me check…"` 这类第一人称进行式开头。
2. `BARE_PROGRESS_ONLY_PATTERN` —— 省略主语的裸动词开头（`"Investigating…"`）。
3. `FOLLOW_UP_PLANNING_PREFIX_PATTERN` —— 先剥掉 `"Next, "` / `"After that, "` / `"Once done, "` 这类连接词再匹配（`:36`-`:40`），防止加个过渡词就绕过。

还有一层反误伤：`hasNonProgressFollowupSentence`（`:43`）—— 如果文本是"我要去查 X。**结论是 Y。**"（第一句进行式，后面有真内容），按句界切开，后半段不是 progress-only 就放行。

判定结果只有两种终态输入：

- 空文本 → `{ terminalOutcome: "blocked", terminalSummary: "Required completion did not produce a final deliverable." }`（`:70`）
- progress-only → `"Required completion ended with progress-only text, not a final deliverable."`（`:78`）

**谁在调它**（全量，`grep` 确认无遗漏）：

| 调用点 | `file:line` |
| --- | --- |
| subagent 完成投影 | `src/agents/subagent-registry-completion.ts:103` |
| subagent 投递失败 | `src/agents/subagent-registry-lifecycle.ts:450` |
| ACP 后台任务 | `src/acp/control-plane/manager.background-task.ts:65` |
| 媒体生成后台任务 | `src/agents/tools/media-generate-background-shared.ts:453,465` |

门禁开关是 `expectsCompletionMessage`（默认 **true**，`src/agents/subagent-spawn.ts:1121` `params.expectsCompletionMessage !== false`）。只有开着时才跑 gate：

```js
const terminal = entry.expectsCompletionMessage === true
  ? resolveRequiredCompletionTerminalResult(completion.resultText)
  : {};
```
—— `src/agents/subagent-registry-completion.ts:101-103`

补充一层：`resolveFinalizedSubagentTaskState` 要求 `endedAt` + `outcome` + completion 捕获三者都 settle 才返回终态（`:75`-`:84`），且 `pauseReason === "sessions_yield"` 时直接返回 `undefined`（暂停 ≠ 完成）。

**同时存在的工具信号档**：`sessions_yield`（`src/agents/tool-catalog.ts:184`）是模型主动让出，落库为 `pause_reason` 而非终态（`src/agents/subagent-registry.types.ts:132` `pauseReason?: "sessions_yield"`），配 `wake_on_descendant_settle` 决定子任务全部落定后是否唤醒（`:133`）。

### 维度 4：循环终止

| 项 | 内容 |
| --- | --- |
| 机制 | **四层，全是结构性上限，没有经济性预算**。① 外层 run loop 重试上限 ② idle-timeout 熔断器 ③ tool-call loop 检测（warn / block 两级 + 全局断路器）④ 超时与并发 lane。 |
| `file:line` | 见下表 |
| 证据 | **源码**；"无花费预算"一条为 **未找到** |

**① 外层 run loop 上限。** `while (true)` 在 `src/agents/embedded-agent-runner/run.ts:1984`，第一件事就是查上限（`:1985`）。上限是算出来的，不是常数：

```
base = 24, perProfile = 8, min = 32, max = 160
scaled = base + max(1, profileCandidateCount) * perProfile
limit = min(max, max(min, scaled))
```
—— `src/agents/embedded-agent-runner/run/helpers.ts:112-135`（`BASE_RUN_RETRY_ITERATIONS = 24`、`RUN_RETRY_ITERATIONS_PER_PROFILE = 8`、`MIN_RUN_RETRY_ITERATIONS = 32`、`MAX_RUN_RETRY_ITERATIONS = 160`），可被 `agents.defaults.runRetries.{base,perProfile,min,max}` 覆盖。注意这是**重试**上限而非 agent step 上限——每个 iteration 是一次模型 attempt（含 failover / auth retry / compaction retry），不是一次 tool call。

**我没有找到 agent 侧的"最大 tool-call 轮次"或 `maxTurns` 配置。** 全量 grep `maxTurns` / `maxIterations` / `maxSteps` / `MAX_TURNS` 在 `src` + `packages` 下只命中：`tools.web.x_search.maxTurns`（xAI 内部检索轮次，`src/config/types.tools.ts:648`）、`sessions_send` 的 A2A ping-pong 上限（`src/agents/tools/sessions-send-helpers.ts:94`）、两处与 agent 无关的循环计数器。**agent 主循环的 step 数无显式上限**——终止靠超时 + loop detection + 模型自己停。记为 **未找到**。

**② idle-timeout 熔断器**（`MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT = 5`，`src/agents/embedded-agent-runner/run/idle-timeout-breaker.ts:16`）。这是全 repo 唯一一条**由真实事故驱动**的成本防线，doc comment 直接写了金额：

> `See issue #76293 for the original report (single heartbeat fire generating 761-1384 paid Anthropic calls in 60 seconds, costing $20-30 per incident).` —— `:13-14`

它的精妙之处在计数复位条件：只有"**完成的**模型进展（durable text / tool-call progress）"才复位，"provider 计费了部分 output token"**不**复位（`:10-11`、决策表 `:54`-`:60`）。这条区分正是防止 wedged provider 在每个 fallback profile 上依次烧钱。

**③ tool-call loop 检测。** 阈值全部可配（`src/agents/tool-loop-detection.ts:39`-`:43`）：`TOOL_CALL_HISTORY_SIZE = 30`、`WARNING_THRESHOLD = 10`、`UNKNOWN_TOOL_THRESHOLD = 10`、`CRITICAL_THRESHOLD = 20`、`GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30`。五个 detector：`generic_repeat` / `unknown_tool_repeat` / `known_poll_no_progress` / `global_circuit_breaker` / `ping_pong`（`:20`-`:25`）。

**默认关闭**：`DEFAULT_LOOP_DETECTION_CONFIG.enabled = false`（`:45`）。阈值有自洽修正——`criticalThreshold <= warningThreshold` 时自动抬成 `warning + 1`，`globalCircuitBreaker <= critical` 同理（`:105`-`:110`），避免配错导致 critical 永不触发。

执行点在 `src/agents/agent-tools.before-tool-call.ts:1410`。`critical` 级别是**真硬阻断**，返回 `{ blocked: true, kind: "veto", deniedReason: "tool-loop" }`（`:1434`-`:1440`）；`warning` 级只记一条日志且做去重（`shouldEmitLoopWarning`，`:1441`-`:1455`）。loop scope 按 `runId` 隔离（`selectHistoryForScope`，`src/agents/tool-loop-detection.ts:76`），所以一个 session 里多个 run 的历史不会互相污染。

还有一个独立的 `postCompactionGuard`（`windowSize` 默认 3，`src/config/types.tools.ts:179`）：专治"压缩后立刻重复同一个 (tool, args, result)"。

**④ 超时与并发。**

| 项 | 默认值 | `file:line` |
| --- | --- | --- |
| agent run 超时 | **48 小时** | `src/agents/timeout.ts:12` `DEFAULT_AGENT_TIMEOUT_SECONDS = 48 * 60 * 60` |
| `timeoutSeconds = 0` 语义 | 视作"无超时"（取 `MAX_TIMER_TIMEOUT_MS`） | `src/agents/timeout.ts:33-39` |
| 顶层 agent 并发 | 4 | `src/config/agent-limits.ts:5` |
| subagent 并发 | 8 | `:7` |
| 单 agent 直接子任务 | 5 | `:9` |
| subagent 嵌套深度 | **1**（默认不允许嵌套 spawn） | `:13` `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1` |
| cron 并发 run | 8 | `src/config/cron-limits.ts:5` |
| heartbeat 默认间隔 | `30m` | `src/auto-reply/heartbeat.ts:24` |
| heartbeat 默认超时 | 10 分钟 | `src/infra/heartbeat-runner.ts:182` |
| cron 失败告警阈值 | 连续 2 次，冷却 1 小时 | `src/cron/service/failure-alerts.ts:8-9` |

**成本/token 预算：未找到。** grep `costLimit` / `spendLimit` / `maxCost` / `budgetUsd` / `dailyLimit` 在 `src` 下**零命中**。`src/config/types.agent-defaults.ts` 里 `budget` 只出现在 context-budget 语境（`:309`、`:524`）。有 `src/infra/session-cost-usage.ts` 做成本**统计**，但没有据此**阻断**的代码路径。这是明确空白。

### 维度 5：context 管理

| 项 | 内容 |
| --- | --- |
| 机制 | **抢占式压缩 + 三路由决策 + 可插拔 context-engine**。核心创新是"压缩不是唯一出路"——把 tool result 截断当作与压缩并列的第三条路。 |
| `file:line` | `src/agents/embedded-agent-runner/run/preemptive-compaction.ts:311`（`shouldPreemptivelyCompactBeforePrompt`）、`src/agents/compaction-planning.ts:13-24`、`src/agents/agent-compaction-constants.ts:6,12`、`src/context-engine/types.ts:7`、`src/context-engine/delegate.ts:22` |
| 证据 | **源码** |

**三路由决策**（`src/agents/embedded-agent-runner/run/preemptive-compaction.ts:370`-`:381`）：

```js
if (overflowTokens > 0) {
  if (toolResultReducibleChars <= 0)                              route = "compact_only";
  else if (toolResultReducibleChars >= truncateOnlyThresholdChars) route = "truncate_tool_results_only";
  else                                                             route = "compact_then_truncate";
}
```

`truncateOnlyThresholdChars = max(overflowChars + buffer, ceil(overflowChars * 1.5))`（`:366`-`:369`）—— 只有当可截断量**显著超过**溢出量时才走纯截断路径。这条 1.5 倍的"从容余量"是我认为最值得抄的第三个形状：避免"截断刚好够"然后下一轮又溢出的抖动。

**压力估算取最大值而非单一来源**（`:333`-`:343`）：把 windowed 视图与 unwindowed 视图分别估一遍取大者，并记录 `pressureSource`（`"transcript_estimate"` / `"unwindowed_transcript_estimate"` / LLM 边界实测）。理由是 windowed 视图可能**掩盖**一个仍会影响底层 transcript 的溢出。

**prompt budget 下限保护**（`src/agents/agent-compaction-constants.ts`）：

```
MIN_PROMPT_BUDGET_TOKENS = 8_000
MIN_PROMPT_BUDGET_RATIO  = 0.5
minPromptBudget = min(8_000, floor(contextTokenBudget * 0.5))
effectiveReserveTokens = min(requestedReserve, contextTokenBudget - minPromptBudget)
```
—— `preemptive-compaction.ts:347`-`:355`。防的是 `reserveTokens` 配大了把 prompt 空间挤到零。CHANGELOG 有对应修复：`CHANGELOG.md:112` "cap the effective reserve against the known model context window so small local models do not enter compaction from the first token"。

**压缩分块参数**（`src/agents/compaction-planning.ts`）：`BASE_CHUNK_RATIO = 0.4`（`:13`）、`MIN_CHUNK_RATIO = 0.15`（`:15`）、`SAFETY_MARGIN = 1.2`（`:17`，estimateTokens 不准的缓冲）、`SUMMARIZATION_OVERHEAD_TOKENS = 4096`（`:24`）。分块时**不切断活跃 tool-use 配对**（`splitMessagesByTokenShare` 里的 `pendingToolCallIds` / `splitCurrentAtPendingBoundary`，`:111`-`:120`）。

**两条安全不变量**，代码里用 `// SECURITY:` 标注：

```js
// SECURITY: toolResult.details and runtime-context transcript entries must never enter LLM-facing compaction.
```
—— `src/agents/compaction-planning.ts:52`、`:64`。`sanitizeCompactionMessages` = `stripToolResultDetails ∘ stripRuntimeContextCustomMessages`（`:72`-`:74`），token 估算与摘要生成共用同一条 sanitize 路径。

**压缩后的 usage 处理**：`stripStaleAssistantUsageBeforeLatestCompaction`（`src/agents/compaction-usage.ts:21`）把压缩点之前的 assistant usage 快照**零化而非删除**——保持结构合法，避免会计逻辑炸（`:70`-`:76`）。三条 stale 判据：无 summary、时间戳早于压缩点、legacy 顺序回退（`:62`-`:65`）。

**可配置面**（`src/config/zod-schema.agent-defaults.ts:159`-`:199`）：`mode: "default" | "safeguard"`、`reserveTokens`、`keepRecentTokens`、`maxHistoryShare`（0.1–0.9）、`recentTurnsPreserve`（0–12）、`identifierPolicy: "strict" | "off" | "custom"`、`qualityGuard.maxRetries`、`midTurnPrecheck`、`postIndexSync: "off" | "async" | "await"`、`memoryFlush.{softThresholdTokens, forceFlushTranscriptBytes}`。

**context-engine 是可插拔 seam**（`src/context-engine/`，9 个文件）。`AssembleResult.promptAuthority` 这个字段设计得很克制（`src/context-engine/types.ts:27`）：自定义 engine 若自己管压缩，可以声明 `"preassembly_may_overflow"` 让通用 precheck **继续生效**——即 opt-in 保留核心防线，而不是接管即免检。`delegateCompactionToRuntime`（`src/context-engine/delegate.ts:22`）让第三方 engine 在不想自己实现压缩算法时回落到内置路径。

**handoff**：`gateway_restart_handoff` 表（`src/state/openclaw-state-schema.sql:615`）带 `expires_at`、`process_instance_id`、`restart_trace_*`。这是 gateway 进程重启交接，**不是** agent 之间的 context 交接。

**subagent context 隔离**：靠独立 session（`subagent_runs.child_session_key`，`:1160`）+ `SubagentSpawnPreparation` 契约（`src/context-engine/types.ts`）。

### 维度 6：委派

| 项 | 内容 |
| --- | --- |
| 机制 | **两层：`task_runs`（单个后台任务）+ `flow_runs`（多步编排）**。默认**不允许嵌套 spawn**。 |
| `file:line` | `src/state/openclaw-state-schema.sql:1119`、`:1273`、`src/config/agent-limits.ts:13`、`src/tasks/task-flow-registry.types.ts:14`、`:17` |
| 证据 | **源码** |

**`docs/nodes/` 不是分布式执行。** 这一点需要明确纠偏 —— `docs/nodes/index.md` 开篇即定义：

> A **node** is a companion device (macOS/iOS/Android/headless) that connects to the Gateway **WebSocket** ... and exposes a command surface (e.g. `canvas.*`, `camera.*`, `device.*`, `notifications.*`, `system.*`)
> Nodes are **peripherals**, not gateways: they don't run the gateway service, and channel messages ... land on the gateway, not on nodes.

node = 外设（摄像头 / 画布 / 通知 / 定位），走 device pairing 授权。**与任务委派无关。** 真正的委派在 `src/tasks/` + `src/agents/subagent-*`。

**flow 的两种 sync mode**（`src/tasks/task-flow-registry.types.ts:14`）：

- `"managed"` —— 有 controller（插件代码），显式推进 `running` / `waiting` / 终态，存任意 JSON step state
- `"task_mirrored"` —— detached ACP / subagent 启动时**自动**创建的单任务 flow，给 detached spawn 一个稳定 handle

**8 种 flow 状态**（`:17`-`:25`）：`queued` / `running` / `waiting` / `blocked` / `succeeded` / `failed` / `cancelled` / **`lost`**。把 `lost` 提升为一等状态，而不是塞进 `failed`，是长程系统的正确取舍——"我不知道它怎么了"和"它失败了"是两种运维动作。

反序列化是 **fail-loud** 的：`parsePersistedFlowValue` 遇到未知值直接 `throw new Error(...)`（`:47`），不静默降级。

**并行度**：subagent 全局 8、单 agent 直接子任务 5、深度 1（`src/config/agent-limits.ts:5`-`:13`）。

**结果回传**：`subagent_runs` 里为投递可靠性开了**一整套字段**（`src/state/openclaw-state-schema.sql:1158`-`:1241`）——`pending_final_delivery` + `_created_at` / `_last_attempt_at` / `_attempt_count` / `_last_error` / `_payload_json`、`announce_retry_count` / `last_announce_retry_at` / `last_announce_delivery_error`、以及 `frozen_result_text` + `fallback_frozen_result_text` 双份结果冻结。加上独立的 `delivery_queue_entries` 表（带 `retry_count` / `recovery_state` / `platform_send_started_at`，`:1084`）。

这套东西说明一件事：**在这个架构里，"结果送达"比"任务执行"更容易失败**（因为投递要过 Telegram / WhatsApp / Slack 等外部通道）。`frozen_result_text` 的存在是承认"agent 会话可能已经清理，但结果还没送到"。

**`commitments` —— agent 自己给自己排的后续。** `src/commitments/types.ts:2` 定义 4 种 kind：`event_check_in` / `deadline_check` / `care_check_in` / `open_loop`，两种来源：`"inferred_user_context"` / **`"agent_promise"`**（`:8`）。后者即"agent 说了会做某事"被抽取成一条带 due window（`due_earliest_ms` / `due_latest_ms` / `due_timezone`）和 `confidence REAL` 的持久承诺（`src/state/openclaw-state-schema.sql:897`）。带 `dedupe_key` 和 `snoozed_until_ms`。抽取走模型（`src/commitments/extraction.ts`）。

**"standing orders" 是纯文档，无源码。** `docs/automation/standing-orders.md` 描述"permanent operating authority for autonomous agent programs"，含 scope / triggers / approval gates / escalation rules 四段结构。我在 `src` / `packages` / `extensions` 下 grep `standing.order`（大小写不敏感）**零命中**。文档自己也说清了实现方式是"把它写进 `AGENTS.md`，靠 workspace bootstrap 每次注入"——即**提示词约定，不是运行时机制**。同理 `agents.defaults.subagents.delegationMode` 的类型注释明写 `"Prompt-only guidance"`（`src/config/types.agent-defaults.ts:474`）。**记为文档档位**，这是 openclaw 的诚实之处，不是缺陷。

---

## 二、extension seam 分析

### 2.1 openclaw 侧：这条 seam 是什么

**interface 有两套，并存且不等价。**

**(a) 类型化 SDK（推荐路径）** —— `definePluginEntry` + `api.*`，从 `openclaw/plugin-sdk/*` 子路径导入。`packages/plugin-sdk/` + `src/plugin-sdk/`，`extensions/AGENTS.md` 把契约定义文件列得很清楚：`src/plugin-sdk/plugin-entry.ts`、`core.ts`、`provider-entry.ts`。`extensions/` 目录自己声明"Treat it as the same boundary that third-party plugins see"——**140+ 个 bundled extension 与第三方走同一条 seam**，这是 seam 干净的最强证据（dogfooding 强制）。

**(b) 裸导出（legacy / 兼容路径）** —— `export default function activate(api)` + `export async function before_tool_call(...)`，`api` 类型自己手写。

**谁强制契约**：`src/plugins/registry.ts`，分项强制力差异很大：

| 注册面 | 是否要求 manifest 声明 | 违反后果 | `file:line` |
| --- | --- | --- | --- |
| `registerTool` | **是**，必须有 `contracts.tools` | 丢弃注册 + `level: "error"` 诊断 | `src/plugins/registry.ts:610`-`:641` |
| tool metadata | **是** | 同上 | `:2140` |
| `registerGatewayMethod` | **否** | 仅冲突检测 | `:772`-`:809` |
| typed hook（`api.on`） | **否** | 仅 conversation-hook 另需显式授权 | `:2591`-`:2623` |

`registerTool` 的双重校验值得点名：既查 `contracts.tools` 是否为空（`:610`），又查每个实际注册名是否都在声明列表里（`findUndeclaredPluginToolNames`，`:629`-`:641`）。**声明即上限，不能超发。**

`registerGatewayMethod` 反过来——不要求声明，但 scope 缺省**fail-closed 到 admin**：

```js
scope: normalizedScope ?? ADMIN_SCOPE,
```
—— `src/gateway/methods/registry.ts:116`。且 `exec.approvals.` / `config.` / `wizard.` / `update.` 四个保留前缀会把插件声明的 scope **强制抬到** `operator.admin` 并发 warn（`src/shared/gateway-method-policy.ts:2`-`:7`、`src/plugins/registry.ts:794`-`:801`）。

**conversation hook 的显式授权门**（`src/plugins/registry.ts:2591`-`:2612`）：非 bundled 插件想挂 conversation 类 hook，必须运维方在 `plugins.entries.<id>.hooks.allowConversationAccess = true` 显式开；bundled 插件默认允许但可被 `= false` 关掉。**权限在运维配置侧，不在插件自述侧** —— 这是 seam 干净的关键。

### 2.2 这条 seam 上谁负责重试、超时、失败上报

**重试：无人负责。** `runModifyingHook`（`src/plugins/hooks.ts:647`-`:692`）是单趟顺序执行，`catch` 里只调 `handleHookError`，**没有任何重试循环**。`runClaimingHooksList`（`:735`-`:757`）同样。重试责任完全落在插件自己身上。

**超时：核心提供机制，但 `before_tool_call` 无默认预算。**

机制层：`withHookTimeout`（`src/plugins/hooks.ts:574`-`:595`）用 `Promise.race`。三级解析优先级（`resolveTypedHookTimeoutMs`，`src/plugins/registry.ts:296`-`:306`）：

```
policy.timeouts[hookName]  >  policy.timeoutMs  >  opts.timeoutMs
```

**注意运维配置优先于插件自报** —— 插件不能通过 `opts.timeoutMs` 覆盖运维设的预算。

默认预算表（`src/plugins/hooks.ts:206`-`:238`）：

| hook | 默认超时 | 类别 |
| --- | --- | --- |
| `agent_end` | 30s | void |
| `before_compaction` / `after_compaction` | 30s | void |
| `channel_pairing_requested` | 2s | void |
| `before_agent_run` | 15s | modifying |
| `before_agent_start` | 15s | modifying |
| `before_agent_finalize` | 15s | modifying |
| `before_prompt_build` | 15s | modifying |
| `resolve_exec_env` | 15s | modifying |
| **`before_tool_call`** | **无** | modifying |
| **`after_tool_call`** | **无** | — |

每个默认值旁边都有 doc comment 说明是哪次事故加的。比如 compaction hook 的 30s（`:206`-`:218`）：

> `in the codex agent harness these hooks fire on the serialized notification queue ... so a hung handler freezes every later codex notification — including turn/completed — and the whole turn hangs.`

`before_agent_start` 的 15s（`:223`-`:229`）:

> `With before_agent_start unbudgeted, an unresponsive handler (e.g. a memory plugin waiting on a hung subprocess) blocked the entire agent pipeline`

**这个 pattern 恰好诊断了 `before_tool_call` 的缺口**：同样的论证完全适用——`before_tool_call` 在每次工具调用的关键路径上，一个 hang 住的 handler 会无限期堵死这次工具调用。它不在默认表里。

重要限定（`:197`-`:205` 的注释）：**超时只是"放弃等待"，不取消插件的底层工作**（`// A timed-out hook is logged and skipped, but the plugin's underlying work is not cancelled.`）。所以一个 hang 住的 handler 超时后仍在后台跑，只是核心不等它了。

**失败上报：分 fail-open / fail-closed 两档，`before_tool_call` 是 fail-closed。**

```js
failurePolicyByHook: {
  before_agent_run: "fail-closed",
  before_install:   "fail-closed",
  before_tool_call: "fail-closed",
},
```
—— `src/plugins/hook-runner-global.ts:46`-`:50`。其余 hook 默认 `"fail-open"`（`src/plugins/hooks.ts:321`）。

`handleHookError`（`:523`-`:534`）：fail-open 就 `logger.error` 后 return；fail-closed 就 `throw new Error(msg, { cause })`。

**这两条组合起来是这条 seam 上最重要的一个事实**：`before_tool_call` = **fail-closed（插件抛错 → 工具调用被阻断）+ 无默认超时（插件 hang → 工具调用无限期挂起）**。审计类插件挂在这个点上是对的（就该 fail-closed），但必须自己兜超时。

**结果合并策略**（`runBeforeToolCall`，`src/plugins/hooks.ts:1277`-`:1308`）设计得比我预期严谨：

- `block === true` 是**粘性**的（`stickyTrue`，`:1296`），且 `acc?.block === true` 时后续插件的返回被整体忽略（`:1285`-`:1287`）
- `shouldStop: (result) => result.block === true`（`:1304`）—— 一旦有插件 block，**跳过所有剩余 handler**
- **参数冻结防护**（`:1289`-`:1295`）：若已有插件 A 发起了 `requireApproval`，插件 B **不能再改 params**。防的是"A 拿着 params X 去问人批准，B 偷偷把 params 改成 Y 后执行"的 TOCTOU
- 按 priority 降序执行（`getHooksForName`，`:277`-`:285`）

### 2.3 MA 侧：MA 通过什么 interface 挂进 openclaw

**路径**：`/Users/guanxueliang/Desktop/Matrix/MatrixAssistant/openclaw-extensions/`

先纠一个事实：**目录下有 7 个子目录，但只有 6 个是扩展。** `git-ai/` 里只有一个 `node_modules/`，**没有 `index.ts`、没有 `openclaw.plugin.json`、没有 `package.json`**（`ls -la` 确认）。它不是一个可加载的插件。`audit-redaction/` 有 `package.json` + `src/` 但**没有 `openclaw.plugin.json`**，也不是独立的 openclaw 插件（看形态是被 `matrixassistant-audit` 依赖的库）。

实际挂载到 openclaw 的是 5 个：

| 扩展 | 挂载 interface | 契约风格 | manifest `contracts` |
| --- | --- | --- | --- |
| `register-gateway-method` | `api.registerGatewayMethod` × 2 | **类型化 SDK** | 无（gateway method 不要求） |
| `archive-restore` | `api.registerGatewayMethod` | **类型化 SDK** | 无 |
| `sdd-workflow-tool` | `api.registerTool` + `api.on('before_prompt_build')` | **手写 `interface`** | `contracts.tools: ["sdd_activate_workflow"]` ✅ |
| `matrixassistant-audit` | `api.on('before_tool_call', …, {priority: 9})` | **裸导出 + `any`** | `hooks: ["before_tool_call"]`（无 `contracts`） |
| `matrixassistant-timetravel` | `api.on('before_tool_call')` + `api.on('after_tool_call')` | **裸导出 + 手写类型** | `hooks: [...]`（无 `contracts`） |

**三种契约风格并存，这是 MA 侧最大的一致性问题。**

**(a) 类型化（好）** —— `register-gateway-method/index.ts:1`-`:5` 从 5 个 SDK 子路径导入真类型：

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { SessionEntry, getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
```

`archive-restore` 同样（`index.ts:4`-`:14`）。

**(b) 手写 interface（脆）** —— `sdd-workflow-tool/index.ts:25`-`:45` 自己声明了一个 `interface OpenClawPluginApi`，只描述它用到的 3 个方法（`registerTool` / `registerToolMetadata` / `on`）。编译能过，但 openclaw 改签名时**编译器不会报错**。

**(c) 裸导出 + `any`（最脆）** —— `matrixassistant-audit/index.ts:172`-`:184`：

```ts
export default function activate(api: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenClaw API uses any
  on: (event: string, handler: (...args: any[]) => void, opts?: { priority?: number }) => void;
  config?: any;
}): void {
  initialize(api);
  api.on('before_tool_call', before_tool_call, { priority: 9 });
}
```

注释里写 `"OpenClaw API uses any"` —— **这个判断不成立**。openclaw 的 `PluginHookHandlerMap` 是完整类型化的（`src/plugins/hook-types.ts:1285`-`:1302`），`PluginHookBeforeToolCallResult` 有精确 shape（`src/plugins/hook-before-tool-call-result.ts:12`-`:28`）。MA 这里放弃了本来可用的类型安全。

### 2.4 seam 上发现的具体问题

**问题 1（高）：`matrixassistant-audit` 在一个 fail-closed 无超时的 hook 上做同步网络 I/O。**

`matrixassistant-audit/index.ts:84`-`:105` 的 `before_tool_call` 里 `await beforeToolCall(..., getWsClient())`，`getWsClient()`（`:35`-`:41`）连的是 `ws://localhost:${MATRIX_AUDIT_PORT || 18792}/audit`。

风险链条（每一环都已在源码中验证）：

1. `api.on('before_tool_call', handler, { priority: 9 })` —— **没传 `timeoutMs`**（`:181`）
2. `before_tool_call` 不在 `DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK` 里（`src/plugins/hooks.ts:223`-`:238`）
3. `getModifyingHookTimeoutMs` 三级解析全部返回 `undefined` → `runModifyingHook` 走 `await promise` 无 race 分支（`:667`）
4. `before_tool_call` 是 `"fail-closed"`（`src/plugins/hook-runner-global.ts:49`）

结论：审计后端不可达（端口未监听 / 进程未起 / 网络挂）时，若 `beforeToolCall` 内部没有自己的超时，**openclaw 的每一次工具调用都会无限期挂住**；若它抛错，**每一次工具调用都被阻断**。

`getWsClient` 里 `wsClient.connect().catch(() => {})`（`:38`）吞掉了连接错误，这意味着"连不上"不会立刻变成抛错——更可能变成**挂住**，也就是四种失败模式里最难诊断的那种。

**修法（两条都在 MA 侧，无需改 openclaw）**：
- 注册时给预算：`api.on('before_tool_call', handler, { priority: 9, timeoutMs: 2000 })` —— `opts.timeoutMs` 在 `resolveTypedHookTimeoutMs`（`src/plugins/registry.ts:304`）第三优先级被读取，确认可用
- 或运维侧配 `plugins.entries.matrixassistant-audit.hooks.timeouts.before_tool_call`（第一优先级，插件覆盖不掉）

注意：即使配了超时，`src/plugins/hooks.ts:202`-`:204` 明确说超时**不取消**插件底层工作——所以 MA 侧仍应在 `beforeToolCall` 内部自带 deadline。

**问题 2（中）：`sessions-custom.getSessionEntry` 的 scope 是 `operator.admin`，作者大概率不是这个意图。**

`register-gateway-method/index.ts:104`-`:122` 注册第二个方法时**没传 opts**（对比第一个方法 `:100` 传了 `WRITE_SCOPE`）。走到 `src/gateway/methods/registry.ts:116` 的 `normalizedScope ?? ADMIN_SCOPE`，于是一个**只读**的"按 sessionKey 取元数据"方法拿到了最高权限要求。

方向是安全的（fail-closed，不是开放），但语义错位：调用方需要 admin 凭据才能做一次只读查询。应显式声明 `{ scope: "operator.read" }`（需先确认 openclaw 的 `OperatorScope` 枚举里的准确取值）。

**问题 3（中）：两个扩展用 stderr 当 IPC 通道，这不是 openclaw 支持的 interface。**

```ts
// matrixassistant-timetravel/index.ts:23
process.stderr.write(`[trace:timetravel] ${JSON.stringify(record)}\n`);
```
```ts
// sdd-workflow-tool/index.ts:64
console.error(`${SDD_AGENT_STATE_TRACE_TAG} ${JSON.stringify(data)}`);   // "[trace:agent-state]"
```

这是一条**绕过 seam 的 side channel**。后果：

- openclaw 对此零感知——没有 schema 校验、没有背压、没有投递保证、没有失败上报
- 消费方（MA 后端）必须做行解析，格式变更无编译期保护
- openclaw 自身有 stderr 治理代码（`CHANGELOG.md:148` "keep child output failures from crashing exec and TUI sessions"、"sanitize ANSI and stray parameter markup"）——任何 sanitize/截断策略变化都可能静默破坏这条通道
- CHANGELOG 里 openclaw 有专门的 `plugin_state_entries` / `plugin_blob_entries` 表（`src/state/openclaw-state-schema.sql:710`、`:760`）和 `src/plugin-state/plugin-state-store.ts`——**有正规的插件持久化 API 没被用**

`emitToolTrace` 的 `try/catch` 吞掉写失败（`:24`-`:26`，注释"stderr 写入失败不应阻塞工具调用"）——不阻塞工具调用是对的，但意味着**丢事件是静默的**，审计/时间旅行这类场景下丢事件是实质性问题。

**问题 4（低）：`matrixassistant-audit` 的 mode refCount 是进程内 `let`，重启即丢。**

`_monitorRefCount` / `_monitorRestoreTimer` 是模块级变量（`index.ts:118`-`:119`）。有 60s TTL 兜底（`AUDIT_MONITOR_TTL_MS`，`:117`）和 `Math.max(0, ...)` 防过度释放（`:145`），`shutdown()` 里清零（`:72`-`:76`）—— 单进程内做得挺仔细。但若 openclaw gateway 在 `monitor` 模式期间硬崩（非 graceful shutdown，`shutdown()` 不执行），重启后 refCount 从 0 开始、mode 回到 `active` 默认值。这个方向是安全的（回到更严格的模式），但**"autopilot 仍在 full_yolo 中"的事实丢了**——重启后 autopilot 会撞上 `active` 审计。

openclaw 侧有现成的正确原语：`state_leases` 表（带 `owner` + `expires_at` + `heartbeat_at`，`src/state/openclaw-state-schema.sql:112`）正是为这类"带租约的跨进程持有计数"设计的。

**问题 5（低）：5 个扩展里只有 1 个声明了 `contracts`。**

只有 `sdd-workflow-tool` 有 `contracts.tools`（因为 `registerTool` 强制要求，否则注册会被丢弃）。其余 4 个没有 `contracts` 块。目前不违规（gateway method 和 typed hook 都不强制），但意味着**这些扩展的能力面在 manifest 上不可见**——运维方无法从 manifest 审计"这个插件能干什么"。`matrixassistant-audit` 和 `matrixassistant-timetravel` 至少写了 `hooks: [...]`（虽然核心不校验），算是部分自述。

### 2.5 seam 干净度判定

**openclaw 侧：干净。** 判据：

1. **interface 收窄而非放宽**：`registerTool` 声明即上限；conversation hook 需运维显式授权；保留命名空间强制抬 scope
2. **权限判据在运维配置，不在插件自述**：`plugins.entries.<id>.hooks.*` 的优先级高于 `opts`
3. **dogfooding 强制**：140+ bundled extension 与第三方共用同一 boundary（`extensions/AGENTS.md`）
4. **每个默认值挂着事故编号**：超时表的 doc comment 带 issue/PR 号（#48534、#76293、#71662、#89090、#91918）
5. **缺省方向一致 fail-closed**：gateway scope → admin，`before_tool_call` 错误 → block

**唯一的结构性缺口**是 `before_tool_call` / `after_tool_call` 无默认超时预算，而这恰好是第三方最常挂的两个点，且前者是 fail-closed。

**MA 侧：不干净。** 三种契约风格并存、两个扩展绕 seam 走 stderr、一个在 fail-closed 无超时的 hook 上做无 deadline 的网络 I/O、一个目录（`git-ai`）是空壳。这不是 openclaw 的 seam 设计问题——`register-gateway-method` 和 `archive-restore` 证明了类型化路径完全可用且好用。

---

## 三、值得 oh-my-matrix 抄的形状 vs 别抄的

### 3.1 deep module（值得抄的形状）

deep 的判据：interface 窄、内部复杂度高、leverage 大。

**① `task-completion-contract` —— 最 deep 的一个。** `src/tasks/task-completion-contract.ts`（95 行）

- **interface**：2 个导出函数，输入一个 `string | null | undefined`，输出一个只有两个可选字段的对象
- **depth**：三层正则 + 连接词剥离 + 句界反误伤，把"LLM 说了完成但其实没交付"这个在实践中反复出现的失败模式编码成可测试的纯函数
- **leverage**：4 个不同 runtime（subagent / ACP / 媒体生成后台任务 / 投递失败路径）共用同一判据
- **locality**：零外部依赖（只 import 一个 utf16 工具），可单独复制

对 oh-my-matrix 的意义：现在的完成判定依赖 verifier agent 跑一趟。这个 module 提供的是**verifier 之前的零成本预筛**——正则命中即 `blocked`，不必消耗一次 agent 调用。对 `/implement` + `/code-review` 每轮的成本结构有直接改善。

**② `on-exit` watcher 的 fail-closed 顺序。** `src/gateway/cron-exit-watchers.ts:168`-`:182`

值得抄的不是 `on-exit` 这个功能，是它的**三条不变量**：

1. **持久化先于触发**。terminal state 写盘成功才 fire；写失败就不 fire。理由明写在注释里："waking without a persisted terminal state would let a gateway restart re-arm and re-run the command"
2. **未知结局 = 不触发**。`run.wait()` reject 时释放 slot 但不 fire（`:148`-`:159`）
3. **所有权 token**。slot 在 await 之前**同步**预留（`:109`-`:111`），`owns()` 做 identity 检查，失去所有权的 in-flight 资源被主动 cancel 而非泄漏（`:137`-`:142`）

对 oh-my-matrix 的意义：`.omc/state/` 是 JSON 文件持久化。ralph / autopilot 的 iteration 推进若不遵守"先持久化再推进"，崩溃重启会重跑已完成的 iteration。第 3 条（armToken）对任何"reconcile 循环 + 异步 spawn"的组合都适用——`.omc/state/` 的 reconcile 若有异步分支，同样需要 identity 检查。

**③ idle-timeout 熔断器的复位判据。** `src/agents/embedded-agent-runner/run/idle-timeout-breaker.ts`（86 行）

值得抄的是那张决策表（`:54`-`:60`）和"**计费 ≠ 进展**"这条区分：

| idleTimedOut | completedModelProgress | 动作 |
| --- | --- | --- |
| true | false | count += 1（wedged provider 候选） |
| true | true | count = 0（模型活着，只是慢） |
| false | true | count = 0 |
| false | false | count 不变 |

`outputTokens > 0` **不**复位计数器（`:10`-`:11`）—— 因为 wedged provider 会持续产生 partial output 计费。这是那次 $20-30/次事故的真正根因。

对 oh-my-matrix 的意义：ralph / ultrawork 的 iteration 若只按"有输出"判进展，会被这种模式打穿。判据应该是**durable progress**（文件被改了 / 测试状态变了 / tool call 成功了），不是"模型说话了"。

**④ 崩溃归一化成一次失败。** `src/cron/service/ops.ts:137`-`:175`

`running_at_ms` 既是运行标记也是崩溃墓碑——**同一个字段，无需额外的 crash 记录**。重启时把它改写成一次普通失败 run，下游的 retry / alert / run log 全部复用既有分支。

对 oh-my-matrix 的意义：`.omc/state/` 里的 `active: true` 完全可以承担同样的双重角色。会话恢复 / compaction 后的 `git status --short --branch` 再检查（CLAUDE.md 的 `failure_mode_guards` 已有此要求）可以升级成"发现 `active: true` 但无对应进程 → 归一化成一次失败 iteration"。

**⑤ 三路由压缩决策 + 1.5 倍从容余量。** `src/agents/embedded-agent-runner/run/preemptive-compaction.ts:311`-`:389`

值得抄的两点：

- **"压缩"不是溢出的唯一出路**。tool result 截断是并列的第三条路，且优先（更便宜——不需要额外的模型调用）
- **1.5 倍阈值**（`:366`-`:369`）：只有可截断量显著超过溢出量才走纯截断，避免"刚好够"导致的下一轮再溢出

**⑥ `lost` 作为一等状态。** `src/tasks/task-flow-registry.types.ts:17`-`:25`

8 种 flow 状态里 `lost` 与 `failed` / `cancelled` 并列。"我不知道它怎么了"和"它失败了"对应不同的运维动作（前者要去查进程/日志，后者看错误信息）。合并成 `failed` 会丢掉这个区分。

配套的 `parsePersistedFlowValue` fail-loud（`:39`-`:48`）：反序列化遇未知值直接 throw，不静默降级。

**⑦ 超时预算表带事故溯源。** `src/plugins/hooks.ts:206`-`:238`

每个默认值旁边一段 doc comment，写清"没这个预算之前发生了什么"，带 issue 号。这让预算值**可审计、可质疑、可调整**——而不是一串谁也不敢动的 magic number。

对 oh-my-matrix 的意义：这是一条**文档规范**而非代码机制，成本极低，适用于 `.omc/` 下所有超时/重试/阈值常量。

### 3.2 shallow module（别抄）

shallow 的判据：interface 宽度接近内部实现复杂度，抽象没有换来简化。

**① `cron_jobs` 的 ~70 列宽表。** `src/state/openclaw-state-schema.sql:975`-`:1046`

单表 ~70 列，其中 delivery 相关 11 列（`delivery_mode` / `delivery_channel` / `delivery_to` / `delivery_thread_id` / `delivery_thread_id_type` / `delivery_account_id` / `delivery_best_effort` / `delivery_completion_mode` / `delivery_completion_to`…），failure alert 相关 12 列（`failure_delivery_*` × 4 + `failure_alert_*` × 8），还有 `job_json` + `state_json` 两个 JSON 逃生舱。

这是**表即 config schema 的展开**。openclaw 有它的理由（需要 SQL 层查询和条件索引），但对 oh-my-matrix 是负债：`.omc/` 是 JSON 文件持久化，没有 SQL 查询需求，抄这个形状等于把配置嵌套结构展平成 70 个平铺字段，失去分组、失去默认值继承、失去可读性。

**② `subagent_runs` 的 43 列 + 6 个 `pending_final_delivery_*` 字段。** `:1158`-`:1241`

`pending_final_delivery` / `_created_at` / `_last_attempt_at` / `_attempt_count` / `_last_error` / `_payload_json` —— 这是一个投递队列被内联到任务表里。旁边**已经有**一张独立的 `delivery_queue_entries` 表（`:1084`，字段几乎同构：`retry_count` / `last_attempt_at` / `last_error` / `entry_json`）。两套并存。

再加 `frozen_result_text` + `fallback_frozen_result_text` 双份结果冻结、`announce_retry_count` + `last_announce_retry_at` + `last_announce_delivery_error` 第三套 retry 状态。**同一个 module 内三套 retry 记账。**

这个复杂度的根源是 openclaw 特有的约束：结果要投递到 Telegram / WhatsApp / Slack 等外部通道，投递比执行更易失败，且 agent session 可能已被清理。oh-my-matrix 是本地 CLI，结果直接进 terminal 或写文件——**没有这个约束，不该继承这个复杂度**。

**③ `src/tasks/task-registry.reconcile.ts` —— 5 行纯 re-export。**

```ts
// Public reconciliation facade for task lookup/status surfaces.
export {
  reconcileInspectableTasks,
  reconcileTaskLookupToken,
} from "./task-registry.maintenance.js";
```

零 depth 的 facade。`src/tasks/` 下 40 个文件里有若干这种 `runtime-internal.ts` / `*-contract.ts` / `*-domain-views.ts` 切分——一部分是为了打破循环依赖（合理），一部分是纯转发（无价值）。**别把文件数当模块化。**

**④ `docs/maturity/` 的 748K 生成物。** `scorecard.md` 316.8K + `taxonomy.md` 431.7K，内容是嵌满 `className="maturity-surface-name"` 的 JSX。

这是给文档站生成用的，不是给人读的，也不是给 agent 读的。相关信息（"Automation: cron, hooks, tasks, polling — M3 Beta, 6 areas"）本身有价值，但这个载体形式对 agent 是纯噪音。别抄这个形状——成熟度信息应该是结构化数据（`taxonomy.yaml` 已经是 635K 的 YAML 了，为什么还要生成 748K 的 markdown）。

**⑤ `standing orders` 的"文档即机制"。** `docs/automation/standing-orders.md`（9.1K，含 scope / triggers / approval gates / escalation rules 四段结构，源码零实现）

openclaw 对此是诚实的（文档自己说了实现方式就是写进 `AGENTS.md`），但这个形状本身对 oh-my-matrix 没有增量——OMC 已经有 `.omc/skills/` + `CLAUDE.md` 注入机制在做同一件事。写一份 9K 的文档描述"把规则写进提示词"不产生新能力。

**真正的空缺在别处**：standing orders 描述的 `approval gates`（哪些动作需要人工签核）和 `escalation rules`（何时停下来问）是**可以做成运行时机制**的，openclaw 没做。oh-my-matrix 的 `AskUserQuestion` + `merge_readiness_*` 门禁已经在这个方向上，比 openclaw 走得更远。

### 3.3 关键 seam / adapter 对照

| openclaw 的 seam | 位置 | oh-my-matrix 的对应物 | 差距 |
| --- | --- | --- | --- |
| context-engine（可插拔 context 管理） | `src/context-engine/registry.ts`、`types.ts:7` | 无（compaction 由 harness 固定提供） | openclaw 的 `promptAuthority` opt-in 设计值得参考：接管压缩 ≠ 免检 |
| plugin hook（typed，带 priority + timeout + failure policy） | `src/plugins/hooks.ts:647` | OMC hooks（`<system-reminder>` 注入） | openclaw 有 per-hook 超时预算 + fail-open/closed 分档；OMC 侧无对应分档 |
| `delegateCompactionToRuntime`（adapter：第三方 engine 回落内置压缩） | `src/context-engine/delegate.ts:22` | 无 | 这是一个好 adapter 形状——扩展点不强迫全量实现 |
| ProcessSupervisor（scopeKey + replaceExistingScope + 进程树生命周期） | `src/process/supervisor/`、`docs/specs/claw-supervisor.md` | `run_in_background` + `TaskStop` | openclaw 的 `scopeKey` + `replaceExistingScope: true` 语义（同 scope 新 spawn 自动替换旧的）值得抄进 OMC 的后台任务管理 |
| `state_leases`（带 heartbeat 的跨进程租约） | `src/state/openclaw-state-schema.sql:112` | `.omc/state/sessions/{sessionId}/` 目录隔离 | OMC 靠目录隔离避免冲突，没有租约原语。多 session 竞争同一资源时无保护 |

---

## 四、明确的空白

以下是我**确实查过但没找到**的，或找到了但只有文档档位的。每条注明检索范围。

**1. agent 主循环无 step 数上限。**
查了：`src` + `packages` 全量 grep `maxTurns` / `maxIterations` / `maxSteps` / `MAX_TURNS` / `MAX_STEPS` / `MAX_ITERATION`。只命中 `tools.web.x_search.maxTurns`（xAI 内部检索，`src/config/types.tools.ts:648`）、`sessions_send` A2A ping-pong 上限（`src/agents/tools/sessions-send-helpers.ts:94`）、两处无关循环计数器。
`MAX_RUN_LOOP_ITERATIONS`（32–160）是**重试**上限，不是 step 上限——每个 iteration 是一次模型 attempt（含 failover / auth retry / compaction retry）。
结论：agent 可以在一个 turn 内无限调用工具，终止靠 48h 超时 + loop detection（**默认关闭**）+ 模型自己停。

**2. 无花费 / token 预算上限。**
查了：全量 grep `costLimit` / `spendLimit` / `maxCost` / `budgetUsd` / `dailyLimit`，**零命中**。`src/config/types.agent-defaults.ts` 里 `budget` 仅出现在 context-budget 语境（`:309`、`:524`）。
有 `src/infra/session-cost-usage.ts` 做成本统计，但没有据此**阻断**的路径。
结论：预算控制完全是结构性的（重试上限、idle 熔断、超时、并发 lane），没有经济性的。对于跑几十小时的长程任务，这是实质缺口。openclaw 自己也知道——idle-timeout-breaker 的注释就是一次 $20-30 事故的补丁，但补的是单一失败模式，不是通用预算。

**3. tool loop detection 默认关闭。**
`DEFAULT_LOOP_DETECTION_CONFIG.enabled = false`（`src/agents/tool-loop-detection.ts:45`）。整套五 detector + 三级阈值 + 全局断路器的机制**默认不生效**，需要运维显式开 `tools.loopDetection.enabled = true`。
这意味着开箱默认配置下，防死循环只剩 48h 超时这一道。

**4. `before_tool_call` / `after_tool_call` 无默认超时预算。**
查了：`DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK`（`src/plugins/hooks.ts:223`-`:238`）+ `DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK`（`:206`-`:221`），两张表都没有这两个 hook 名。
而 `before_tool_call` 是 `"fail-closed"`（`src/plugins/hook-runner-global.ts:49`）。fail-closed + 无超时 + 在每次工具调用的关键路径上 = 第三方插件可以无限期堵死核心。
其他 hook 的预算注释里的论证（`before_agent_start`、`before_compaction`）完全适用于此，只是没加。

**5. hook 层无重试机制。**
查了：`runModifyingHook`（`:647`-`:692`）、`runClaimingHooksList`（`:735`-`:757`）、`runVoidHook`（`:620`-`:642`）。三者都是单趟执行 + `catch` → `handleHookError`，**无任何重试循环**。
重试责任完全在插件侧。MA 的 5 个扩展里没有一个实现了 hook 级重试。

**6. hook 超时不取消底层工作。**
源码明写（`:197`-`:205`、`:202`-`:204`）：`// A timed-out hook is logged and skipped, but the plugin's underlying work is not cancelled.`
所以超时只是"核心不等了"，hang 住的 handler 仍在后台占资源。要真正取消，插件必须自己接 `AbortSignal` —— 但 `PluginHookRegistration`（`src/plugins/hook-types.ts:1295`-`:1302`）里**没有 signal 字段**。

**7. `standing orders` 零源码实现。**
查了：`src` + `packages` + `extensions` 全量 grep `standing.order`（大小写不敏感），**零命中**。
`docs/automation/standing-orders.md`（9.1K）描述的四段结构（scope / triggers / approval gates / escalation rules）是**提示词约定**。文档自己说清了：写进 `AGENTS.md`，靠 workspace bootstrap 每次注入。
**记为文档档位。** 同类：`agents.defaults.subagents.delegationMode` 的类型注释明写 `"Prompt-only guidance"`（`src/config/types.agent-defaults.ts:474`）。

**8. `docs/nodes/` 不是分布式任务执行（纠正 team-lead 的假设）。**
`docs/nodes/index.md` 开篇定义 node = companion device（macOS/iOS/Android/headless），暴露 `canvas.*` / `camera.*` / `device.*` / `notifications.*` / `system.*` 命令面，走 device pairing 授权。文档明写 "Nodes are **peripherals**, not gateways"。
与任务委派无关。真正的委派在 `src/tasks/` + `src/agents/subagent-*`。

**9. `flow_runs` 的 revision CAS 只验到字段定义层。**
`revision INTEGER NOT NULL DEFAULT 0`（`src/state/openclaw-state-schema.sql:1279`）+ `revision: number`（`src/tasks/task-flow-registry.types.ts:67`）是源码确认的。
"每次变更带 expected revision，stale write 被拒" 来自 `docs/automation/taskflow.md`。我**没有**逐行追到 `task-flow-registry.store.sqlite.ts` 里的 CAS 比较点。
**记为文档 + 部分源码。** 要用这个形状前应补验。

**10. `git-ai` 目录是空壳。**
`/Users/guanxueliang/Desktop/Matrix/MatrixAssistant/openclaw-extensions/git-ai/` 下只有 `node_modules/`，无 `index.ts` / `openclaw.plugin.json` / `package.json`（`ls -la` 确认）。
它不是一个可加载的 openclaw 插件。`audit-redaction/` 有 `package.json` + `src/` 但无 `openclaw.plugin.json`，形态上是被 `matrixassistant-audit` 依赖的库，不是独立插件。
所以"7 个扩展"实际是 **5 个挂载到 openclaw 的扩展 + 1 个依赖库 + 1 个空壳**。

**11. 未验证：`src/process/supervisor/` 的实现细节。**
`DESIGN-cron-on-exit.md` 引用了 `src/process/supervisor/adapters/child.ts` 的 `signalProcessTree(SIGTERM→SIGKILL)` 行为（issue #71662），`docs/specs/claw-supervisor.md` 描述了 fleet supervision 模型。我读了 `cron-exit-watchers.ts` 对 supervisor 的**调用面**（`spawn({ mode, scopeKey, replaceExistingScope, argv, cwd, env, timeoutMs, captureOutput })` + `run.wait()` + `run.cancel()` + `cancelScope()`），**没有**读 supervisor 本体。
`replaceExistingScope` 的确切语义、`timeoutMs` 的执行方式、`run.wait()` 的 reject 条件均未从实现侧确认。上面 3.3 表里推荐抄 `scopeKey` + `replaceExistingScope` 形状时应先补这一段。

---

## 附：调研覆盖范围

**读过的骨架文件**：`AGENTS.md`（40.4K，`CLAUDE.md` 是它的 symlink）、`README.md`（85.3K，按需 grep）、`VISION.md`、`DESIGN-cron-on-exit.md`（全文）、`extensions/AGENTS.md`、`docs/specs/claw-supervisor.md`（部分）、`docs/nodes/index.md`（部分）、`docs/automation/standing-orders.md`（部分）、`docs/automation/taskflow.md`（部分）、`CHANGELOG.md`（2.8M，按关键词 grep）。

**目录结构确认**：`src/`（67 个子目录）、`packages/`（21 个）、`apps/`（7 个）、`extensions/`（**140+ 个**）、`skills/`（39 个）、`docs/`（31 个子目录）。

**未覆盖**：`src/process/supervisor/` 本体、`src/acp/` 深度、`apps/`（Android/iOS/macOS 原生）、`extensions/` 中除 `workboard` / `logbook` 目录结构外的具体实现、`taxonomy.yaml`（635K）、`docs/maturity/`（748K，仅 grep）、`docs/plugins/manifest.md`（104K）、`docs/plugins/architecture-internals.md`（62.7K）。
