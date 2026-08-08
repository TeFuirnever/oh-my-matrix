# Autopilot 长程自主运行（Long-Horizon Autonomy）

> **状态**: APPROVED (v2.1 — 合并版 + MA 范围决策) — 已过四轮独立对抗 review（事实核查 / 对抗质疑 / 引用核实 / 跨报告合并核查）
> **日期**: 2026-08-01（v1: 2026-07-31）
> **提交基线**: MatrixAssistant `6b8c17fdc` (dev) · oh-my-matrix `b39deb6` (master, autopilot v3.1.0)
> **范围**: autopilot 能否无人值守跑完一个长任务；跨引擎（oh-my-matrix `packages/autopilot`）与 MA（MatrixAssistant）两侧全链路
> **MA 侧定位（v2.1 产品决策，2026-08-01）**: **后台逻辑 + 异常提醒，不新增 UI 界面**。运行面板提案撤销（§8.1），跨轮驱动改为主进程单驱动（§5.10）
> **合并来源**: 本文 v1（缺口 A–I）+ [oh-my-matrix 深度审计 2026-07-31](../../../../DynamicWorkflow/oh-my-matrix/docs/audits/autopilot-deep-review-2026-07-31.md)（发现 3.1–3.12，下称「审计」）。两份文档有 **3 处结论互相矛盾**，本文逐条裁决（§10.5）
> **父文档**: [autopilot 权威设计文档](./design.md) — 本文是其「长程自主运行」专题补充，不重复其架构总览
> **适用受众**: LLM coding agent、架构审视者、实施者

---

## 渐进式加载说明

沿用 [design.md](./design.md) 的三级披露：**L1** 章节摘要 → **L2** `<details>` 展开 → **L3** 代码 `file:line`。

本文所有机制断言均**读源码实测**得出，非文档转述。这是刻意的：本仓有过设计文档与代码现状脱节的先例（见 oh-my-matrix `docs/design/autopilot-conditional-judging-design.md` 记载的那份 research report——它引用的路径在本仓根本不存在，全部诊断作废）。

**v2 新增的取证层级**：除源码外，本版还读了**磁盘上真实的 run checkpoint** 与 **MA 生产日志**（§2.7）。运行时证据推翻了两份文档的若干纯静态推断——这是 v2 最重要的方法论变化。

---

## 目录

1. [目标与非目标](#1-目标与非目标)
2. [现状机制](#2-现状机制)
3. [业界对照](#3-业界对照)
4. [缺口清单](#4-缺口清单)
5. [方案](#5-方案)
6. [测试策略](#6-测试策略)
7. [迁移与兼容](#7-迁移与兼容)
8. [未采纳与理由](#8-未采纳与理由)
9. [不推翻的既有决策](#9-不推翻的既有决策)
10. [对抗 review 记录](#10-对抗-review-记录)

---

## 1. 目标与非目标

### L1 摘要

**目标**：让 autopilot 能无人值守跑完长任务；跑不完时**明确停下并说清原因**——后者优先级高于前者。一个静默停摆、或声称完成但什么都没验证的 run，比一个明确 pause 并报出原因的 run 危害更大。

**结论先行（v2 修正，按证据强度分层）**：

**已证**——引擎的**单轮工程质量高**：纯函数 reducer、ADR-016 status 唯一写者不变式、原子 checkpoint、崩溃恢复、防误完成守卫，861 个测试（857 passed / 4 合理跨平台 skip，58 文件，实测全绿）且核心逻辑零 mock。

**已证**——但**没有任何证据表明长程自主 loop 曾真正工作过**。磁盘上唯一的真实 run（用户任务、非测试）在 `totalContinuations: 0` 时死亡且不可自愈；MA 全部日志中 `[autopilot]` 只出现 67 行，且只有 `activate rejected` 与 `stall detected` 两种，没有任何一轮成功续跑的痕迹（§2.7）。

**未证**——该 run 零轮死亡的**确切**内部原因。已排除若干假设（§2.7 L2），但未能定位到具体是哪个守卫提前返回。本文不把推断写成结论。

**已证**——长程能力有结构性缺口：完成判定在多数场景退化为「正则匹配模型话术」、无墙钟/成本上限、停滞检测**双向**失效（既误报长工具、又漏报空转）、瞬时 API 错误落入「不可恢复」、checkpoint 存取根目录不一致导致「配了 workspace 就恢复不了」、跨轮驱动依赖渲染进程、压缩后上下文只剩一个 `"Turn N/M completed"` 计数串。

### 非目标

| 非目标 | 理由 |
|---|---|
| 独立 LLM 评审员判定完成 | oh-my-matrix ADR-019 D2 已定边界，本文不推翻 |
| 自建 durable execution 引擎 | host 已有 session store + 本地 checkpoint，重复造 |
| 推翻「渲染进程驱动跨轮」 | host 能力边界，非设计缺陷（§4 P0-7 有 host 侧证据） |
| 追求「能跑更久」本身 | 无上限的长跑不是能力，是失控 |
| 本文即实施 | 所有方案**未实施**。实施须按 oh-my-matrix TDD 约定先写回归测试 |

---

## 2. 现状机制

### L1 摘要

两层循环：**引擎不轮询、不自发驱动**，完全由 host hook 事件驱动；轮内 `revise` 重试、轮间靠 host 注入 + 渲染进程发 `chat.send`。状态机是双层的——用户可见 `status` 是 `orchestrationState` 的派生字段。

### 2.1 循环触发点

<details>
<summary>L2 — 四个 hook 与五态决策</summary>

- `agent_turn_prepare`（`packages/autopilot/index.ts:718`）：turn 开始前注入 goal / progress / effort；
- `before_agent_finalize`（`index.ts:518`）：turn 结束时调 `decideContinuation`（`src/continuation-engine.ts:45`），返回五态之一：

| 决策 | 含义 | 代码 |
|---|---|---|
| `revise` | **同轮**重试，host 继续注入指令，不新开 turn | `index.ts:552` |
| `cross_turn` | `turnAttempts >= maxAttemptsPerTurn` 时，调 host `enqueueNextTurnInjection` 排下一轮 | `index.ts:564` |
| `pause` | 停止并标 `pauseReason` | `index.ts:589` |
| `complete` | 进 evidence gate，通过则 done | `index.ts:595` |
| `finalize` | 停止注入（run 已禁用 / 用户已 stop） | `index.ts:543` |

- `after_tool_call`（`index.ts:669`）：刷 `lastActivityAt`，出错时记 `trackToolError`；
- `agent_end`（`index.ts:1018`）：canary 自愈——若 `before_agent_finalize` 从未触发（hook 被禁或降级），走 fallback 跨轮注入，或在上限处直接 pause。

**v2 补充：canary 只有一个置位点**。`canaryFired.add(sessionKey)` 全仓仅出现在 `before_agent_finalize` 内部（`index.ts:520`）。故「`didFire` 为假」严格等价于「`before_agent_finalize` 未执行」，无第三种可能。这个等价关系是 §2.7 运行时推断的基础。

</details>

### 2.2 双层状态机

<details>
<summary>L2 — status 是派生字段，orchestrationState 才是真状态机</summary>

用户可见 `AutopilotStatus = idle|running|paused|done`（`src/types.ts:1`）是**派生字段**。真实状态机是：

```
OrchestrationState = unclaimed | claimed | running | retry_queued | released | blocked | done
```
（`src/types.ts:17-24`）

全部转移集中在纯函数 reducer `orchestratorReducer`（`src/orchestrator.ts:84-376`）。ADR-016 的「唯一写者」不变式由外层包装强制：

```ts
// src/orchestrator.ts:74-82
const next = reducerCore(state, event);
const derivedStatus = deriveStatus(next);   // 每次 dispatch 后重算并覆盖
return next.status === derivedStatus ? next : { ...next, status: derivedStatus };
```

持久化层同样不信任落盘的 status——`loadCheckpoint` 显式重算（`src/state-persister.ts:313-315`：*"BLOCKER #1: re-derive status. Never trust cp.status."*）。

**注 1**：`orchestrator.ts:51` 那句注释「currently reference-only — no production writer uses it yet」**已过期**：`index.ts` 有 15+ 处生产调用（`index.ts:323/624/678/728/862/956/1084/1274/1294/1326/1348/1427/1440` 等）。

**注 2（v2）**：该不变式在 reducer 内成立，但**有一条越权旁路**——legacy setter `resume()` / `pause()` 直接写 `orchestrationState` 并自行调 `deriveStatus`（`src/autopilot-state.ts:51-66`、`:82-97`）。`pause()` 的写入与 reducer 语义一致，`resume()` 的不一致，构成 §4 P1-8。

</details>

### 2.3 现有上限

| 上限 | 默认值 | 位置 |
|---|---|---|
| `maxAttemptsPerTurn` | 5 | `src/types.ts:332` |
| `maxTotalContinuations` | 50（UI 实际传 30） | `src/types.ts:333` / MA `autopilot-shared.ts:10` |
| `toolErrorThreshold` | 3 | `src/types.ts:334` |
| `maxConcurrentAutopilot` | 5 | `src/types.ts:335` |
| `stallTimeoutMs` | 300s；无 tokenBudget 时 ×2 = 600s | `src/workflow-config.ts:18` / `index.ts:142-146` |
| `maxRetries` + 指数退避 | 3 次；10s→300s 封顶，**无 jitter** | `src/workflow-config.ts:17` / `src/retry-queue.ts:10-14` |
| `tokenBudget` | **可选；未配置即无上限** | `src/types.ts:280`，判定在 `continuation-engine.ts:84` |
| **墙钟 / 时长上限** | **ABSENT** — 全仓无 `maxDurationMs`/`deadline` 字段 | — |
| **美元成本上限** | **ABSENT** — `estimatedCostUsd` 仅展示，无任何 pause 逻辑读它 | `src/projection.ts:70` |
| 孤儿清理 | 24h | `index.ts:80` |

**关键结论**：`DEFAULT_CONFIG`（`src/types.ts:331-337`）**只有**轮数与错误计数两类刹车，无时间、无成本、无 token 默认预算。且 `tokenBudget` 判定在 `before_agent_finalize` 的 turn 边界——**单轮内部可超支任意多**。

### 2.4 完成判定链

<details>
<summary>L2 — 正则 + 早停守卫 + evidence gate 三段</summary>

**第一段：正则匹配模型输出**。`isTaskComplete`（`src/completion-detector.ts:1-40`）剥离代码块后匹配中英完成话术（「所有任务已完成」/ `all tasks completed` 等），带否定守卫（`所有任务已完成，但还需…` 不算完成，`completion-detector.ts:24`；`not all tasks` 排除，`:33`）。

**第二段：早停守卫**。`decideContinuation` 不信任早期完成信号（`continuation-engine.ts:57-68`）：`totalContinuations < minTurnsBeforeComplete(state)`（普通 2 轮，可验证且受信任的 3 轮，`continuation-engine.ts:37-43`）时强制 `revise`。

**第三段：Evidence Gate**。`evaluateEvidence`（`src/evidence-gate.ts:23-95`）跑 `validation.commands`：required 失败/超时/缺失 → `failed`；无命令 → `skipped`；否则 `passed`。命令经 `execFile` 执行（`src/command-runner.ts:100`，非 shell 字符串拼接），失败 stderr 截 300 字符存 `summary`（`command-runner.ts:65`）。

失败信号会**回注下一轮指令**（`buildFailureBlock`，`continuation-engine.ts:157-183`），抗压缩遗忘。`failed` 不会假 done——H1 bug 已修（`index.ts:637-643` 有详细记载）。

</details>

### 2.5 无人值守权限面

<details>
<summary>L2 — allow-by-default + MA 强制 trustWorkspace</summary>

每次工具调用过 `before_tool_call`（`index.ts:850-923`，priority 10）→ `decidePermissionForEvent`。关键事实：**autopilot 不传 `defaultDeny`**，注释明示 *"trusted autopilot run-scoped: keep allow-by-default"*（`index.ts:881`）。

硬阻断只有三类 + 一个算子配置：

| 类别 | 位置 |
|---|---|
| `credential_access` | `permission-policy.ts:410` |
| `system_write` | `permission-policy.ts:418` |
| `workspace_cleanup` | `permission-policy.ts:495` |
| `highRiskTools`（算子配置的工具名denylist） | `index.ts:873-875` |

`destructive_git` 需 `workflowAllowsDestructiveGit` + cwd 在 workspace 内（`permission-policy.ts:448-457`）。

**shell 替换（`$()`/反引号）只在 `defaultDeny` 模式下阻断**（`permission-policy.ts:553`）——autopilot 主会话不设 `defaultDeny`，故该阻断对 autopilot 不生效。

`require_approval` 在策略层**从不返回**（grep `outcome: 'require_approval'` 零命中）——`index.ts:910-922` 只处理 `allow` 与 `block`，故这是死分支而非漏洞。

**trustWorkspace**：引擎默认 `false`（`index.ts:1201`），但 **MA 在启动时强制置 `true`**（`electron/utils/init-default-plugins.ts:686-691`，注释标 "POLICY OVERRIDE"，且显式把持久化的 `false` 重置回 `true`）。后果：工作区自带的 `npm test` 等脚本原样执行——这是**已记录并接受**的残余 RCE 面（`src/pages/Chat/components/autopilot-send.ts:40-44` 的 SECURITY 注释）。

**审计的一致结论**：WORKFLOW.md 验证命令有二进制白名单 + 解释器 eval-flag 过滤（`src/workflow-config.ts:55-111`）；`before_tool_call` 事件形状有编译期契约防宿主改字段后 fail-open（`tests/event-shape.contract.ts`）。安全面是本模块做得最好的部分之一。

</details>

### 2.6 UI 侧调用链

<details>
<summary>L2 — 从点选到跨轮，逐跳 file:line</summary>

```
ThinkingIntensitySelector.tsx:52   选 'autopilot' → setMeta(sessionKey, {thinkingIntensity})
  ↓
ChatInput.tsx:829                  handleSend 检测到 autopilot
  → activateAutopilotOrAbort(...)  autopilot-send.ts:193
      ack 预检（autopilot-send.ts:201）未接受 YOLO 条款 → 'ack_required'
      → activateAutopilotSession   autopilot-send.ts:56
          invokeRpc('gateway:rpc', 'autopilot.activate', {sessionKey, maxTotalContinuations:30, workspacePath})
            electron/main/ipc/gateway-handlers.ts:512 → { success, result } | { success:false, error }
  ↓ 'proceed'
ChatInput.tsx:941                  onSend() → gateway:rpc chat.send
  ↓ 每轮结束，插件 emit sessions.changed（含 pluginExtensions.autopilot 投影）
gateway-handlers.ts:618            转发 gateway:notification（始终转发，不受窗口可见性影响）
src/stores/gateway.ts:354          → handleSessionsChangedAutopilot
src/stores/autopilot-continuous.ts:93   setProjection
src/stores/autopilot-continuous.ts:96   若 needsCrossTurnResume → chat.send(message:'')  ← 跨轮由渲染进程发起
```

投影经 `registerSessionExtension`（`index.ts:1105-1143`）以 `namespace: 'autopilot'` 挂到 session entry，**推送式**（无轮询）。

</details>

### 2.7 运行时实测（v2 新增）

### L1 摘要（2.7 运行时实测）

前六节是静态阅读。本节是**运行时取证**，它推翻了两份文档的若干纯静态推断，也是本文最重要的新增内容。三项证据：磁盘上唯一的真实 run、MA 生产日志统计、活动时间戳的两个刷新点。

<details>
<summary>L2 — 唯一真实 run 的解剖</summary>

全盘扫描（`find` 全部 `.autopilot/checkpoints/`）后，**只有一个**真实 run checkpoint，来自用户会话而非测试：

```json
{"runId":"run-0dbf1cf9-87e7-4a9e-8f5f-2263b92b131c",
 "sessionKey":"agent:main:session-1783418763302",
 "goal":"[Tue 2026-07-07 18:06 GMT+8] 将工作区切换到 \"…/TestProject\" 目录。\n创建一个坦克大战的html",
 "orchestrationState":"blocked","blockedReason":"max_retries_reached","status":"paused",
 "totalContinuations":0,"turnAttempts":0,"maxTotalContinuations":20,
 "needsCrossTurnResume":true,"enabled":true,"totalTokensUsed":0,
 "startedAt":1783418775470,"lastActivityAt":1783420230384,
 "retry":{"attempt":3,"nextRetryAt":1783419910361,"lastError":"stalled","recoverable":true},
 "workflow":{…,"stallTimeoutMs":300000,"maxRetries":3,"validation":{"commands":[]}}}
```

（路径 `…/TestProject/.autopilot/checkpoints/run-0dbf1cf9-….json`，`savedAt` = 18:30:30，`startedAt` = 18:06:15，跨度 24 分钟。）

**逐项解读**：

| 字段 | 读数 | 含义 |
|---|---|---|
| `totalContinuations: 0` | 一轮都没续过 | 长程 loop 从未启动 |
| 无 `progress` 字段 | `progress` **是**被序列化的字段（`state-persister.ts:139` 写、`:285` 读）——故缺失 = 从未被设置 | `agent_end` 的**正常路径**（`index.ts:1092-1095` 是 `progress` 唯一写点）从未执行 |
| `totalTokensUsed: 0` | `llm_output` 累加点（`index.ts:953`）从未命中 | 插件从未观察到任何模型输出 |
| `retry.attempt: 3` + `lastError: 'stalled'` | 三次 stall 重试耗尽 | 死因是 stall，非任务失败 |
| `blockedReason: max_retries_reached` | 不在 `RESUMABLE_BLOCKED_REASONS` | reducer 层面不可 resume（但见 §4 P1-8：RPC 会放行） |
| `validation.commands: []` | 空 | 印证 §4 P0-4：默认无验证命令 |
| `workflow.workspace.root: ".matrix/autopilot-worktrees"` 与实际 `workspacePath` 并存 | 死配置项与真实路径同时存在 | 印证 §4 P2-15 |
| `lastActivityAt` 推进 24 分钟 | **不能**证明有真实 agent 活动 | `stall_timeout`（`orchestrator.ts:218`）与 `retry_due`（`:239`）reducer 分支**自身**就写 `lastActivityAt: event.now`。时间推进只反映巡检在跑 |

**时间线复原**（与 `stallTimeoutMs: 300000` 及退避 10s/20s/40s 自洽）：18:06 activate → `claimed` → 无 turn 到来 → 5 分钟后 stall #1 → 退避 → stall #2 → stall #3 → `max_retries_reached` → 18:30 落盘。全程零轮、零 token。

**已排除的假设**：

- ~~「插件被双重注册，第二次注册清空了内存 map」~~ —— 驳回。那些 map 是模块级 `let`（`index.ts:82-85`），任何清空对 stall 巡检**同样可见**，而巡检明确仍认得该 run（日志有 `stall detected` 且带正确 runId）；且清空块位于 `_resetForTest` 内，生产环境会 throw（`index.ts:183-185`）。
- ~~「`progress`/`degraded` 只是没被序列化」~~ —— `progress` 确实被序列化（上表），故其缺失有意义。`degraded` **确实**不被序列化（`state-persister.ts` 的 checkpoint 结构无该字段，且恢复时硬置 `true`，`:300`），故 `degraded` 的缺失**不能**作为证据——本文不使用它。

**未能排除的**：`agent_end` 是否触发过但在三个早退守卫处返回（`resolveSessionKey` 无值 / `findRunBySession` 未命中 / `!enabled`，`index.ts:1019-1023`）。checkpoint 显示 `enabled: true`，日志显示 sessionKey 存在，故最可疑的是 `findRunBySession` 与 `resolveSessionKey` 的口径（参见 §4 P2-19 的自认未审计面）。**本文不把该推断写成结论。**

</details>

<details>
<summary>L2 — MA 生产日志统计</summary>

日志目录 `~/Library/Application Support/matrix-assistant/logs/`（按日切分，2026-05-28 起）。

| 统计项 | 数值 | 意义 |
|---|---|---|
| `[WARN ] [Gateway stderr]` 总行数 | 12,505 | 插件 WARN **确实**被采集 |
| `[INFO ] [Gateway stderr]` 总行数 | **0** | 该前缀根本不存在——原因见下方「为何插件 INFO 永不出现」，**不是**级别过滤 |
| `[autopilot]` 前缀行数 | 67 | = **65** 条来自实时 gateway（全部带 `[Gateway stderr]` 标签）+ **2** 条来自一次性 `[plugin-inspect] exited 1. FULL stderr` 子进程转储（非实时通道，不计入活性证据） |
| 其中 `activate rejected: … status=running` | 46 | 重复激活被拒 |
| 其中 `stall detected: … orchState=retry_queued\|blocked` | 19 | 停滞与死亡 |
| **canary 警告**（`"before_agent_finalize never fired"`） | **0** | 见下 |
| `after_tool_call error` / 任何续跑成功痕迹 | 0 | 无成功多轮证据 |

**为何插件 INFO 永不出现（机制已定案，两次误判的更正记录见 §10.4）**

插件的 info 日志**确实被写出**，但在 MA 侧的第二跳被**降级为 DEBUG 后过滤掉**。逐跳如下：

| 跳 | stdout 路径（`log()`，即 info） | stderr 路径（`warn()`） |
|---|---|---|
| 1. 插件侧 | `console.log`（`src/logger.ts:65`）。⚠️ 级别门是**开的**：logger 读 `AUTOPILOT_LOG_LEVEL ?? LOG_LEVEL`（`logger.ts:33`），而 MA spawn 时传 `LOG_LEVEL: 'info'`（`packages/gateway/src/manager.ts:2036`）→ `shouldLog('info')` 为真 | `console.warn`（`src/logger.ts:64`） |
| 2. MA gateway 收集 | `child.stdout` **确实**逐行分类并落盘（`manager.ts:2166-2181`），支持 `debug`/`info`/`warn` 三档。但 `classifyStdoutMessage`（`manager.ts:678`）的**兜底分支返回 `debug`**——`[autopilot] …` 不匹配任何已知模式，故一律落 `logger.debug` | `child.stderr` 逐行经 `classifyStderrMessage` 分类，非噪声行一律 `logger.warn`（`manager.ts:2145-2161`） |
| 3. MA logger 落盘 | **DEBUG 默认不落盘**——`Default level is INFO; TRACE/DEBUG are opt-in at runtime`（`packages/logger/src/log-level.ts:5`）→ **在此丢弃** | WARN ≥ INFO → **落盘** |

**日志实证支持该链条**：`[DEBUG] [Gateway stdout]` 只出现在 **5 月**的 6 个日志文件里（当时 DEBUG 被临时开启，含 4779 行 `mem4claw` 输出，证明该通道确实能落盘）；而 autopilot 的 gateway stderr 行只出现在 **6 月及以后**。两者**零重叠**——即 autopilot 运行期间 MA logger 恰好处于 INFO，故其 info 输出全部落在 DEBUG 档被丢。

> ⚠️ 顺带修正一处易误读的证据：日志里那 2 行 `[autopilot] config: maxAttemptsPerTurn=…` **不是**实时 gateway 输出——它们紧跟在 `[WARN ] [plugin-inspect] exited 1. FULL stderr (625 chars):` 之后，属一次性探测子进程的 stderr 转储。不能用它证明实时 stdout 通道通畅。

**canary 零次的意义（关键推理，结论不变）**：canary 警告走 `warn()`（`index.ts:1074`），与 `stall detected`（`index.ts:1429`）**同函数、同通道（stderr）**。后者出现 19 次证明该通道通畅，故 canary 的零次**不能**用「日志未采集」解释。上述更正只改变了「为什么 INFO 看不见」的解释，不影响这条推理。

结合 §2.1 的等价关系（`didFire` 假 ⟺ `before_agent_finalize` 未执行），有两种解释，二者都指向同一结论：

1. `before_agent_finalize` **确实**在触发（故 `didFire` 恒真，canary 分支从不进入）——那么长程 loop 的主路径是活的，零轮死亡另有原因；
2. `agent_end` 自身从未执行到 canary 检查（在早退守卫处返回）——那么两个 turn 结束 hook 都没生效。

**本文采信的结论只到这一层**：无论哪种，**都没有任何一轮成功续跑的证据**。这已足以支撑 §4 的优先级排序，无需在二者间强行择一。

</details>

<details>
<summary>L2 — 活动时间戳有两个刷新点（裁决停滞检测矛盾的依据）</summary>

`lastActivityAt` 经 `agent_activity` 事件刷新，共**三个**派发点，分属不同 hook：

| 派发点 | 所属 hook | 相对工具执行的时机 |
|---|---|---|
| `index.ts:863` | `before_tool_call`（`:850`） | **工具派发前** |
| `index.ts:679` | `after_tool_call`（`:669`） | **工具完成后** |
| `index.ts:957` | `llm_output`（`:925`） | 模型输出时 |

这一事实同时解释了两份文档看似矛盾的结论：

- **一次长工具**（10 分钟 `npm test`）：派发时刷新一次，然后 **静默直到完成**。若单工具耗时 > `stallTimeoutMs`（默认 300s），stall **误报**。→ 审计 3.2 的触发条件成立。
- **高频空转**（反复读同一批文件）：每次工具都刷新两次，`lastActivityAt` 永不老化，stall **漏报**。→ 本文 v1 缺口 B 成立。

故 `checkStall`（`src/stall-detector.ts:26-49`）是纯静默计时器，**双向失效**：对慢而有效的工作误报，对快而无效的空转漏报。两份文档各看到一半。

</details>

---

## 3. 业界对照

### L1 摘要

本节结论来自并行深度检索 + 三票对抗验证（104 个检索/验证 agent，约 100 条断言逐条 WebFetch 一手来源核实）。**验证中被驳回的断言均为「过度概括原文」而非事实错误**，已剔除；下表只保留经核实且与本仓缺口直接对应的项。

引用规则（本文自律）：只写论文原文支持的范围，不外推到「业界普遍如此」。**v2 补充**：合并审计引入的来源时，按证据等级分层标注——一手文档、搜索摘要级、二手转述三档分明。

### 3.1 经核实的外部结论（学术来源）

| 业界结论 | 一手来源 | 对应缺口 |
|---|---|---|
| 完成判定应基于**执行结果**（测试套件通过 / 最终容器状态），而非模型自述。SWE-Marathon：评分「基于提交的容器状态，而非到达该状态所用的命令或中间推理」 | arXiv 2606.07682 §3.1；arXiv 2604.14820 §4.2（`r_exec` 执行奖励）；arXiv 2508.03501 §3.1 | [P0-4](#p0-4v1-缺口-a--审计-34完成判定在多数场景退化为正则匹配模型话术) |
| 纯二元终局奖励**倾向鼓励**（原文 encourages）agent 尽早提交而非充分验证。⚠️ 原文未称其为「作弊/gaming」，勿如此转述 | arXiv 2508.03501 §6（Discussion, "Uncertainty and Risk-Awareness"） | [P0-4](#p0-4v1-缺口-a--审计-34完成判定在多数场景退化为正则匹配模型话术) |
| **自条件效应**（self-conditioning）：上下文中已存在的自身错误会让后续步骤更易出错；这是经反事实实验验证的机制，非单纯长度效应 | arXiv 2509.09677（ICLR 2026）§3.2 + Appendix A | [P1-11](#p1-11v1-缺口-e--审计-310压缩后上下文只剩计数串无结构化-plan-工件) |
| 长程失败中「原地打转」占比可观：标注失败轨迹中 GAIA ~20% / ALFWorld ~48% / WebShop ~33% 表现为查询重构死循环等重复模式 | arXiv 2509.09677 Appendix A（引 Zhu et al. 2025a 标注） | [P0-5](#p0-5v1-缺口-b--审计-33无墙钟成本上限单-turn-内可任意超支) / [P0-6](#p0-6v1-缺口-b--审计-32停滞检测双向失效) |
| 过程缺陷有可操作分类：**Dead Step**（动作已执行，但结果既未进入后续消息也未影响后续决策）、**Long Chain**（执行路径异常拉长，核心信号是「持续拉长」而非步数阈值）、**Ghost Context**（冗余/过时/已被摘要过的上下文重复占位） | arXiv 2605.20251（ProcCtrlBench）Appendix A.1 / A.2 | [P0-6](#p0-6v1-缺口-b--审计-32停滞检测双向失效) / [P1-11](#p1-11v1-缺口-e--审计-310压缩后上下文只剩计数串无结构化-plan-工件) |
| 压缩可能**静默擦除安全约束**——in-context 治理约束在 compaction 后失效（"Governance Decay"） | arXiv 2606.22528（arXiv 预印本，待同行评审） | [P1-11](#p1-11v1-缺口-e--审计-310压缩后上下文只剩计数串无结构化-plan-工件) |
| 长程 agent 需要**项目级 halt**：自评判定「问题无法通过继续在单任务层面修正解决」时，直接停止整个项目，而非继续烧轮次 | arXiv 2512.03549（PARC）§2 | [P0-5](#p0-5v1-缺口-b--审计-33无墙钟成本上限单-turn-内可任意超支) |
| 自评反馈应从**独立上下文**做出，并用于控制整体推进（仅当自评判定完成才进入下一任务） | arXiv 2512.03549 §2 / §3.4 | [P0-4](#p0-4v1-缺口-a--审计-34完成判定在多数场景退化为正则匹配模型话术) |
| 硬 turn 上限（`Tmax`）作为训练时的回合上界设置，提供回合边界保证——不能只依赖显式完成信号。⚠️ 论文未明文称其为「独立终止机制」，此处不作更强表述 | arXiv 2508.03501 Appendix C（Tmax 超参）+ §3.3（submit 终止） | 印证 `maxTotalContinuations` 的兜底价值（并见 [P1-9](#p1-9新增degraded-兜底路径丢增量turn-计数可能永不递增)：该兜底在降级模式下可能失效） |
| LITL 攻击证明 HITL 对话可被伪造以诱导用户批准恶意操作，故 HITL 审批不可作为唯一安全兜底 | Checkmarx Zero, "Turning AI Safeguards Into Weapons with HITL Dialog Forging"（2025-12） | [§2.5 权限面](#25-无人值守权限面) |

### 3.2 经核实的外部结论（工程实践来源，v2 合并自审计 §5）

<details>
<summary>L2 — Anthropic / OpenAI / Ralph 的一手实践，及证据等级标注</summary>

**一手文档级**（官方文档或原始作者贴文）：

| 结论 | 来源 | 对应缺口 |
|---|---|---|
| agent 两大失败模式之一是「看到已有进展就宣布整个项目完工」。对策：initializer 写结构化 feature list（**选 JSON 因模型更不敢乱改**），coding agent 只许改 `passes` 字段；"passing" 必须基于**端到端验证**，不是跑个单测就算 | Anthropic《Effective harnesses for long-running agents》 | P0-4 / P1-11 |
| 每个 coding agent 固定开场仪式：读 progress 文件和 git log → **先跑 init.sh + 冒烟测试确认环境没坏** → 选最高优先级未完成项 → **一次只做一个** → 结束时 git commit + 追加进度摘要 | 同上 | P1-11（本模块续跑指令仅 `"Continue from where you left off."` + 截断 goal/progress） |
| structured note-taking（定期把笔记写到 context 外文件）与 compaction 互补，非替代 | Anthropic《Effective context engineering for AI agents》 | P1-11 |
| `max_turns` 默认存在，超限抛 `MaxTurnsExceeded` 且可配**受控 fallback 输出**；guardrail tripwire 触发即硬中止整个 run；工具按风险分级，**参数无法安全解析时 fail-closed** | OpenAI Agents SDK 文档（guardrails / running agents / human-in-the-loop） | P0-5（本模块到顶仅 pause，无受控收尾） |
| `while :; do cat PROMPT.md \| agent; done` —— 每轮全新 context + 同一份确定性输入文件，跨轮共享状态**只走磁盘工件**；plan 是一次性的，走偏时删掉重跑 planning 比硬推便宜 | Ralph 原帖（ghuntley.com/ralph，经 Wayback）+ 官方 Playbook（github.com/ghuntley/how-to-ralph-wiggum） | P1-11 |
| backpressure 必须是**确定性门禁**——测试/typecheck/lint/build 不过就不 commit；prompt 只说 "run tests"，具体命令写死在工程文件里 | 同上 | P0-4 |

**二手转述级（仅用于说明量级，不作为设计依据）**：成本控制的「三类预算并联」实践（迭代 + 墙钟 + token/成本，任一触发即熔断，80% 处先告警，计数器必须持久化）见于 RelayPlane、stevekinney 等转述；审计 §7 自承其中 nexgismo/openlegion/gravity/fountaincity 四篇为**搜索摘要级**来源，两起事故金额（$6,531、$47,000）**未追溯到一手报告**。本文引用其方法论（多维预算并联）而不引用其数字。

</details>

### 3.3 对本设计的直接影响

1. **P0-4 的修法方向与业界一致** — `skipped ≠ passed`（§5.2）有一手来源支撑；且 Anthropic 的「JSON feature list + 只许改 passes」直接支持 §5.3 的结构化台账；
2. **P0-6 的停滞检测应对齐 Dead Step 定义** — 「动作执行但结果不影响后续决策」比「零文件变更」更准；**Long Chain** 提示阈值应看「持续拉长趋势」而非单纯步数；
3. **P1-11 的台账必须考虑 Ghost Context 与 Governance Decay** — 台账要**替换**而非叠加旧摘要；压缩后必须**重新注入**约束，不能假设 in-context 约束存活；
4. **P0-5 应采「多维并联 + 受控收尾」而非单纯 pause** — OpenAI 的 `MaxTurnsExceeded` + fallback 输出是可借形态；
5. **不要把「加人工确认」当安全兜底**（LITL）——权限收敛仍需 allowlist / 隔离等结构性手段。

### 3.4 与参考实现（oh-my-claudecode）的结构差异

<details>
<summary>L2 — 哪些能借、哪些借不了</summary>

`oh-my-claudecode` 的 autopilot 是 **Stop-hook prompt 型 loop**：Stop 事件 → `checkAutopilot`（`src/hooks/autopilot/enforcement.ts:249`）→ 若未检出阶段完成信号则返回 `{shouldBlock:true, message:<continuation_prompt>}`，Claude Code 把 `reason` 作为上下文注入并自动开新轮。

**可借（与编译型 orchestrator 同构）**：

- 阶段 FSM + 每阶段完成门；
- 硬/软双层迭代上限（hard 500 / per-session 10，`enforcement.ts:378-394`）；
- **状态全部落盘、每次 Stop 从磁盘重读**（`.omc/state/sessions/{id}/autopilot-state.json`、`.omc/autopilot/spec.md`、`.omc/plans/autopilot-impl.md`）——因此模型上下文压缩**不影响** loop 协调状态。这正是本文 §5.3 台账要借的核心思路；
- compare-before-write 并发守卫（`state.ts:233-265`）；
- **集中式错误分类与硬豁免清单**（审计 B1）：所有豁免/放行条件集中在一个 resolve 函数，rate-limit / auth / user-abort / context-limit 逐条列出且每条带 issue 出处 → 直接对应 §5.3 重写 `classifyRecoverability`；
- **防自批的相关化批准令牌**（审计 B2）：批准必须带每次验证重新生成的 request-id、只能出现在审查者 subagent 的 tool_result 里、注入示例标签先剥离再匹配 → 对应 §5.2/§5.5「完成信号应来自 tool_result 通道而非 agent 文本」；
- **thinking-only 连胜熔断**（审计 B3）：连续 3 个无 tool_use 的 assistant 回合即释放；任何 tool_use 重置；读不出 transcript 时 fail-open 不误杀 → 对应 §5.4；
- **分级重试指导**（审计 B5）：同一错误前 5 次「修复后重试」，≥5 次改口「换完全不同的方法/询问用户」 → 对应 §5.3 的 `buildRetryInstruction` 分级；
- **相同失败检测**（审计 B6）：失败描述归一化（去时间戳/行号）后连续 3 次相同即退出 → 与 §5.4 互补。

**借不了（依赖「模型即 loop」）**：

- 完成判定 = 正则扫模型输出的魔法字符串（legacy 路径无独立验证器）；
- 阶段 prompt 即程序文本（自然语言只有模型能执行）；
- 子 agent 输出散文式 APPROVED/REJECTED 作为验收；
- 恢复靠「重述 prompt」而非恢复调用栈。

**明确不要抄的（审计 §4.2，本文认同）**：

- **软上限自动 +10 续期 + `hardMaxIterations` 默认 0（不限）**——ralph 实际无内在终止，runaway 是显式设计取舍。本模块 50-continuation 硬顶更安全，应**保留**硬顶并补受控收尾；
- **内存计数器跨进程失效**——其 todo-continuation 上限是模块级 Map 而 hook 每事件新进程，5 次上限很可能从未生效。佐证「熔断计数器必须持久化」；本模块虽是长驻进程，但崩溃恢复时 `toolErrorCount` 归零（§4 P3-20）是同族病；
- **完成信号可伪造 + 读整个 transcript**——本模块不读 transcript 是对的，但 completion-detector 的正则本质同病（P0-4）。

**结论**：借其**落盘型协调状态**与**集中式错误分类**，不借其 prompt 型阶段机。

</details>

---

## 4. 缺口清单

### L1 摘要

**v2 合并说明**：本节把 v1 的缺口 A–I 与审计的发现 3.1–3.12 合并为**统一优先级序列 P0-1 … P3-20**，去重、裁决矛盾、并补入本次运行时核查的 6 条新发现（N 系列）。每条标注**来源**与**裁决结论**，便于回溯两份原始文档。

严重度定义：**P0** = 不修则「无人值守过夜跑」不可接受；**P1** = 显著削弱长程可靠性或有数据/并发风险；**P2** = 正确性/可维护性长尾；**P3** = 影响有限但有独立修复价值。

### 来源对照总表

| 编号 | 缺口 | 来源 | 裁决 |
|---|---|---|---|
| P0-1 | 无成功多轮 run 的证据；唯一真实 run 零轮死亡 | **v2 新增（N4）** | 运行时取证 |
| P0-2 | checkpoint 存取根目录不一致 → 配 workspace 即不可恢复 | **v2 新增（N1）** | 运行时取证 |
| P0-3 | 瞬时 API 错误落「不可恢复」 | 审计 3.1 | 成立，且比原述更重 |
| P0-4 | 完成判定退化为正则 | v1 缺口 A ⊕ 审计 3.4 | 合并；v1 触发条件更准 |
| P0-5 | 无墙钟/成本上限 | v1 缺口 B ⊕ 审计 3.3 | 合并 |
| P0-6 | 停滞检测**双向**失效 | v1 缺口 B ⊕ 审计 3.2 | **两者各对一半** |
| P0-7 | 跨轮驱动依赖渲染进程 | v1 缺口 C | 成立；审计 3.2 的「双 turn」后果被驳回 |
| P1-8 | resume 绕过守门 ⊕ 可恢复集全不可达 | **v2 新增（N2+N6）**；推翻审计 3.1/3.7 前提 | 运行时+穷举核实 |
| P1-9 | degraded 兜底丢增量 | **v2 新增（N3）** | 代码核实 |
| P1-10 | maxBuffer 冤杀 verbose 测试 | 审计 3.8 | 成立 |
| P1-11 | 压缩后只剩计数串；无结构化计划工件 | v1 缺口 E ⊕ 审计 3.10 | 合并；审计的「截断 500」夸大 |
| P1-12 | 可观测性近乎为零 | v1 缺口 D | 成立 |
| P1-13 | 子 agent 扇出不透明 | v1 缺口 F | 成立，v2 补 hook 对照表 |
| P1-14 | `released` 停滞盲区 | 审计 3.6 | 盲区真，暴露面**小于**原述 |
| P2-15 | 无隔离工作区 + 死配置 | v1 缺口 H | 成立 |
| P2-16 | `hasNoActionableTask` 绕过早停守卫 | v1 缺口 I | 成立 |
| P2-17 | `isRunStuck` 误判退避中 | 审计 3.5 | 触发条件真，**后果被驳回** |
| P2-18 | 长尾集合 | 审计 3.12 | 部分成立，2 条剔除 |
| P2-19 | `sessionKey` 双源未审计 | **v2 新增（N5）** | 代码自认 |
| P3-20 | turn 计数回退 + 恢复阈值漂移 | v1 缺口 G ⊕ 审计 3.10 | v1 的 P3 定级正确 |
| — | ~~session-index 跨 run 竞态~~ | 审计 3.9 | **驳回**，见 §8 |
| — | ~~模型失败无 fallback~~ | 审计 3.12 | **归属 host**，见 §8 |
| — | ~~验证期 effort 强制 low 是相位倒挂~~ | 审计 3.12 | **措辞错**，见 §8 |

### P0-1（新增）无成功多轮 run 的证据；唯一真实 run 零轮死亡

> **v2 新增**。这条排第一不是因为它最容易修，而是因为它**决定其余缺口的语义**：若长程 loop 从未真正转动过，那么「完成判定不准」「无成本上限」这些缺口在生产上尚未有机会显现——它们是**待兑现的**风险，而 P0-1 是**已发生的**故障。

**实测证据**：见 §2.7 全文。三项互相独立的取证：

1. 磁盘唯一真实 run：`totalContinuations: 0`、无 `progress`、`totalTokensUsed: 0`、`blockedReason: max_retries_reached`；
2. MA 全部日志中 `[autopilot]` 仅 67 行，只有 `activate rejected` 与 `stall detected` 两种，**零**续跑痕迹；
3. canary 警告零次，且已证该日志通道通畅（同级 WARN 出现 19 次）。

**触发条件**：**已定位为 P0-1b**（跨轮 resume 发空消息被 gateway 拒绝）。该机制解释了本条的全部观察现象——见 P0-1b 的对照表。**（8-08 更新）** P0-1b 机制已于 8-08 随 §5.10 修复（见 P0-1b 条目状态注记），但「loop 真能多轮转」仍待 §5.0 运行时验证——**P0-1 不因机制修复而自动闭环**。

> **本条与 P0-1b 的关系**：P0-1 是**现象**（无成功多轮 run 的证据），P0-1b 是**机制**（跨轮驱动的空消息被拒且失败被静默吞掉）。修 P0-1b 是让 loop 转起来的第一步，但**不保证充分**——`totalTokensUsed: 0` 仍提示 `llm_output` hook 可能也未匹配到 run（见 P2-19 的 sessionKey 双源问题），这部分仍未证。

**后果**

- 用户视角：选了 autopilot、发出任务，run 激活成功，然后**静默停摆 24 分钟**，最终显示 `paused`；
- 该 run 在 reducer 层面不可 resume（`max_retries_reached` 不在可恢复集），实际能 resume 但一轮后复死（见 P1-8）；
- **对本文其余部分的意义**：所有「长程」缺口的实施优先级都应以此为前提——先让 loop 真正转起来并可观测，再谈上限与判定精度。

**必须先做的定位工作**（不在本文方案范围，属实施前置）

1. 建立可复现路径：真实 MA 会话 + 真实 workspace + 观察 `[autopilot]` 日志序列；
2. 把 `resolveSessionKey` 的每 hook 取值加 debug 日志（当前 INFO 不落盘，需临时提到 WARN 或改采集级别）；
3. 若确认 `before_agent_finalize` 在 MA 的 runner 下不触发，则 §5 的多数方案落点需整体重估——见 §5.1 的落点修正。

### P0-1b（新增）跨轮 resume 发空消息，被 gateway 无条件拒绝 —— P0-1 的机制级根因

> **v2 新增，本次核查最重要的发现**。这条把 P0-1 从「原因未知」升级为「机制已定位」。两份原始报告都没有它，因为它跨越三个进程边界（渲染进程 → Electron 主进程 → gateway），任何单侧静态阅读都看不见。

**实测证据（完整链条，逐跳核实）**

**第 1 跳**——渲染进程发**空消息**（`src/stores/autopilot-continuous.ts:129-135`）：

```ts
const idempotencyKey = `autopilot-cross-${sessionKey}-${sentContinuations}`;
window.electron.ipcRenderer
  .invoke('gateway:rpc', 'chat.send', {
    sessionKey,
    message: '',          // ← 空
    idempotencyKey,
  })
```

**第 2 跳**——gateway 的 `chat.send` **无条件拒绝**空消息（`build/openclaw/dist/chat-CYQVDnLG.js`，偏移 72116 附近）：

```js
const rawMessage = inboundMessage.trim();
if (!rawMessage && normalizedAttachments.length === 0) {
  respond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"));
  return;
}
```

该守卫**位于任何注入 drain 之前**，且经检索**无任何 plugin/system origin 豁免**（`allowEmpty` / `skipEmpty` / `isSystem` 等在守卫上下文 3KB 内零命中）。故排队好的跨轮注入永远等不到承载它的 turn。

**第 3 跳**——主进程把 RPC 失败**包装成已解决的 Promise**（`electron/main/ipc/gateway-handlers.ts:533`）：

```ts
return { success: false, error: String(error) };   // ← 不 throw
```

**第 4 跳**——渲染进程把它**当成功处理**（`autopilot-continuous.ts:135-142`）：

```ts
.then(() => {
  // GAP-10: Reset failure counter on success
  useAutopilotContinuousStore.setState((state) => {
    const next = new Map(state.crossTurnFailures);
    next.delete(sessionKey);        // ← 清零，而这次其实失败了
    return { crossTurnFailures: next };
  });
})
.catch((err: unknown) => { … })     // ← 永不执行
```

`.then()` 不检查 `result.success`，故每次失败都被记为成功并**清零失败计数**。

**后果（这解释了 §2.7 观察到的全部现象）**

| 观察 | 由本缺口解释 |
|---|---|
| `needsCrossTurnResume: true` 但 `totalContinuations: 0` | 跨轮请求每次都被拒，engine 侧标志位从未被消费 |
| 三次 stall → `max_retries_reached` | 无 turn 到来 → `claimed` 状态静默 → stall 巡检按 300s 节奏判定停滞 |
| 无 canary 警告 | 没有任何 turn 结束，`agent_end` 自然不触发 |
| 未出现 degraded、未出现 toast | `MAX_CROSS_TURN_FAILURES`（3）**永不达到**——计数每次被清零 |

**且这三条防线全部是死代码**：失败计数、`degraded` 标记、`crossTurnDegraded` toast（`autopilot-continuous.ts:101-116`）——设计上是「重试 3 次后告知用户」，实际因计数清零而永不触发。用户看到的就是**完全静默的停摆**。

**修法**（**v2.1 更新：不再单独修**）：v2 原计划三处分别修——(a) 发非空占位文本、(b) `.then()` 检查 `result.success`、(c) 重新界定重试时的幂等键语义。**§5.10 翻转为主进程单驱动后，第 3、4 跳所在的渲染侧驱动整体删除**，(b)(c) 随之消失，只剩 (a) 以「主进程发非空占位文本」的形式并入 5.10。

⚠️ **状态（8-08 核实更新）**：§5.10 已于 2026-08-08 在 MA 侧落地——主进程单驱动 `autopilot-cross-turn-driver.ts:486` 发非空占位 `'[autopilot: next turn]'`，渲染侧空消息驱动已删（`autopilot-continuous.ts` 缩到 99 行）。**P0-1b 根因已消除，本条从「活的缺口」改为「已修待运行时验证」**：它仍是 §2.7 那个真实 run 零轮死亡的机制级根因，但机制已修，loop 真能多轮转待 §5.0 验证。原「P0-6 双 turn 风险的当前抑制器」随之解除——空消息不再先被拒，并发场景**现已可达**（见 §10.6 / 行 698，均已更新）。

**为何 861 个测试没抓到**：UI e2e 全部 mock IPC（`getAutopilotMockScript()`），mock 的 `chat.send` 不实现空消息校验；引擎测试根本不经过渲染进程。这是**跨进程契约无测试**的典型漏网。

### P0-2（新增）checkpoint 存取根目录不一致 → 配了 workspace 就永远恢复不了

> **v2 新增**。这是本次核查发现的最干净的结构性 bug：写路径与读路径用**不同的根**。

**实测证据**

| 方向 | 根的来源 | 代码 |
|---|---|---|
| **写** | `state.workspace?.root ?? process.cwd()` | `resolveCheckpointRoot`（`index.ts:207-209`），被 `saveCheckpoint`（`:249`）、`deleteCheckpoint`（`:244`/`:351`）使用 |
| `state.workspace.root` 的填充 | activate 时的 `payloadWorkspacePath ?? process.cwd()` | `index.ts:1280`、`:1300` |
| 路径模板 | `{workspaceRoot}/.autopilot/checkpoints/{runId}.json` | `state-persister.ts:5-7`、`:32` |
| **读（进程启动）** | **硬编码** `process.cwd()` | `register()`：`const root = process.cwd(); listResumableCheckpoints(root)`（`index.ts:493-495`） |
| **读（会话重连）** | **硬编码** `process.cwd()` | `session_start`：`const root = process.cwd(); lookupRunIdBySessionKey(root, sessionKey)`（`index.ts:980-982`） |

**磁盘取证**：

- 唯一真实 checkpoint 与唯一 `session-index.json` 都在 `TestProject/.autopilot/checkpoints/`（= 用户选的 workspace）；
- gateway 的 cwd 是 OpenClaw 安装目录（`getOpenClawResolvedDir()` → `realpathSync(getOpenClawDir())`，`electron/utils/paths.ts:189-199`）；
- 该目录下 `build/openclaw/.autopilot/` **只有一个 audit jsonl，没有 checkpoints 子目录**——即恢复路径扫的地方从来是空的。

**触发条件**

用户配置了 workspace（`workspacePath` 非空）且它不等于 gateway 的 cwd。**这是 MA 的正常用法**——ChatInput 就是从 workspace store 取值传入的（`ChatInput.tsx:830`）。

**后果**

- 崩溃/重启后，`register()` 扫不到任何 checkpoint → 所有 run 静默丢失，不 resume、不报错、无日志（`listResumableCheckpoints` 对不存在的目录返回空数组）；
- `session_start` 的重连恢复同样失效；
- **与 P0-4 的致命交互**：evidence gate 只在**配了 workspacePath** 时才有实质约束（自动补验证命令要求显式路径，`index.ts:1207-1213`）。于是：
  - 配 workspace → 完成判定有效，但**崩溃不可恢复**；
  - 不配 workspace → 崩溃可恢复（cwd 一致），但**完成判定退化为正则**。

  **二者不可兼得。** 这是两份原始报告都没发现的组合缺陷。

### P0-3（审计 3.1）瞬时 API 错误落「不可恢复」，且分类是子串匹配

**实测证据**

`classifyRecoverability`（`src/retry-queue.ts:22-72`）是**子串匹配**，可恢复关键词仅：`transient` / `tool fail`（`:26`）、`timeout`（`:29`）、`stall`（`:32`）、`validation`（`:43`）、`injection`/`rejected`（`:47`）。**未知一律不可恢复**（`:70-71`，注释 *"Unknown errors — treat as non-recoverable for safety"*）。

真实世界的 `rate limit` / `overloaded` / `429` / `529` / `ECONNRESET` / `socket hang up` **全部落入 unknown**。后续路径（`orchestrator.ts:174-187`）：

```ts
if (!shouldRetry({ attempt, maxRetries, recoverable: classification.recoverable })) {
  return { ...state, orchestrationState: 'blocked',
    blockedReason: classification.recoverable ? 'max_retries_reached'
      : toBlockedReason(event.error ?? 'unknown error', 'unrecoverable_error'), … };
}
```

→ `unrecoverable_error`，**不在** `RESUMABLE_BLOCKED_REASONS`（`orchestrator.ts:28-33`）。

**engine 确实看得见该错误**（host 侧核实）：`agent_end` 由 host 在 turn 失败时以 `success: !aborted && !promptError` + `error: formatErrorMessage(promptError)` 派发（嵌入式 runner）；CLI runner 亦有 `buildFailedAgentEndEvent` 走 `success: false`。故本缺口**不是**理论问题。

**附带发现（子串双向误伤，审计原述成立）**

| 误伤方向 | 证据 | 例 |
|---|---|---|
| 含 `token` 或 `budget` 字样 → 判**不可恢复** | `retry-queue.ts:60-62` | `max_tokens exceeded`、`token limit`、tokenizer 相关报错——都是可重试的 |
| 含 `timeout` 字样 → 判**可恢复** | `:29-31` | 路径或消息里恰好含 `timeout` 的**不可恢复**错误会被反复重试 |
| 含 `permission` → 不可恢复（**这条是对的**） | `:39-41`，且刻意置于 validation/injection 之前，注释说明混合串的处理 | — |

**触发条件**

任何一次限流或网络抖动。过夜跑遭遇的概率接近 1。

**后果**

单次 API 抖动即让 run 落 `blocked`。reducer 层面不可 resume；实际因 P1-8 可被强制 resume，但 `retry.attempt` 不清零，故**只能多跑一轮就再死**。用户只能 stop + 重新 activate，丢失 continuation 计数与进度。

### P0-4（v1 缺口 A ⊕ 审计 3.4）完成判定在多数场景退化为「正则匹配模型话术」

**实测证据**

Evidence Gate 只在 `trustWorkspace=true` **且**拿到 `workspacePath` 时才有实质约束。链路：

1. 引擎默认 `validation.commands = []`（`src/workflow-config.ts:26-29`），两仓**均无 WORKFLOW.md**（实测 `ls` 确认）；**运行时印证**：§2.7 的真实 checkpoint 里 `validation.commands: []`；
2. `commands.length === 0` → `evaluateEvidence` 返回 `skipped`（`src/evidence-gate.ts:27-35`）；
3. `skipped` 与 `passed` **同等对待** → `orchState = done`（`src/orchestrator.ts:261-271`）：

   ```ts
   if (event.evidence.status === 'passed' || event.evidence.status === 'skipped') {
     return { ...state, orchestrationState: 'done', status: 'done', enabled: false, … };
   }
   ```

MA 靠两点救回主路径：强制 `trustWorkspace=true`（`init-default-plugins.ts:686-691`）+ `detectValidationCommands` 自动补 `npm test`/`go test`/`cargo test`/`pytest`（`src/project-detector.ts:26-90`）。

**触发条件**

**用户未配置 workspace 时**：`ChatInput.tsx:830` 的 `wsPath = getWorkspacePath(currentSessionKey)?.path ?? undefined` 为 `undefined` → activate 不带 `workspacePath` → 自动补命令不触发（`index.ts:1207-1213`：*"Only auto-detect when an explicit workspace path is provided"*）→ evidence 恒 `skipped` → 完成判定退化成纯正则。

ChatInput 会 toast 提示（`detectWorkspaceValidationGap`，`autopilot-send.ts:172-179`），**但仅是提示——evidence 仍静默走向 done**。

<details>
<summary>L2 — 另一条「不传 workspacePath」的路径是死代码（v1 对抗 review 更正）</summary>

`ContinuousModeToggle.tsx:62-65` 的 `handleToggle` 同样不传 `workspacePath`，但该分支**不可达**：

- 组件在无投影时直接 `return null`（`ContinuousModeToggle.tsx:44-46`）；
- 而 `status === 'idle'` 的投影会被立刻清除（`src/stores/autopilot-continuous.ts:87-90`，GAP-11）；
- `handleToggle` 首行要求 `isIdle`（`ContinuousModeToggle.tsx:53-56`）。

「有投影」与「投影为 idle」互斥 → 该激活路径永不执行。故它**不是**本缺口的触发条件，§5.10 中对它的修复属防御性清理，非 P0。

</details>

**后果**

- 未配置 workspace 时唯一的完成门是「模型说了句『所有任务已完成』」+ 2 轮早停守卫；
- 放大因素 1：Evidence Gate **只在 `complete` 分支跑一次**（`index.ts:603`）——长任务全程无中途校验，最后一次跑挂了就整体重试；
- 放大因素 2：`skipped` 与 `passed` 在 UI 上**完全同形**（`evidenceStatus` 未渲染，见 P1-12）——「没验证」和「验证通过」用户无法区分；
- 放大因素 3（v2）：与 P0-2 组合后，「有验证」与「可恢复」互斥。

### P0-5（v1 缺口 B ⊕ 审计 3.3）无墙钟/成本上限，单 turn 内可任意超支

**实测证据**

`DEFAULT_CONFIG`（`src/types.ts:331-337`）只有 `maxAttemptsPerTurn: 5`、`maxTotalContinuations: 50`、`toolErrorThreshold: 3`、`maxConcurrentAutopilot: 5`、`excludedAgents: []`——**无 `tokenBudget`、无时长、无成本**。

- 全仓无 `maxDurationMs` / `deadline` / `maxWallClock` 字段（grep 零命中）；
- `estimatedCostUsd` 只在投影里计算展示（`src/projection.ts:53-71`，Sonnet 定价常量 `AUTOPILOT_INPUT_COST_PER_M_USD` / `..._OUTPUT_...`），**无任何 pause 逻辑读它**；
- `tokenBudget`（可选）的判定在 `decideContinuation`（`continuation-engine.ts:84-86`），即 `before_agent_finalize` 的 **turn 边界**——单轮内部可超支任意多。一轮深度调试 turn 烧掉的 token 可能超过整个预算。

**触发条件**

任何长跑。尤其：单个超长 turn（大规模重构、长构建循环）+ 未配 `tokenBudget`（默认状态）。

**后果**

- 唯一普适刹车是 turn 计数（50，UI 传 30），而**每轮可以任意长、任意贵**；
- 与 P1-9 叠加：降级模式下 turn 计数可能根本不递增 → 连这唯一刹车都失效；
- 业界共识是三类预算**并联**（迭代 + 墙钟 + 成本），单看轮数在「每轮都很贵」场景失效（§3.2）。

### P0-6（v1 缺口 B ⊕ 审计 3.2）停滞检测双向失效

> **裁决**：两份报告各描述了**一个方向**，都对。v1 说漏报，审计说误报。根因同一：`checkStall` 是纯静默计时器，而「静默」与「有效工作」不相关。

**实测证据**

`checkStall`（`src/stall-detector.ts:26-49`）只比较 `now - lastActivityAt > stallTimeoutMs`，且只在 `running` / `claimed` 状态生效（`:31`）。而 `lastActivityAt` 有**三个**刷新点，分属 `before_tool_call`（派发前，`index.ts:863`）、`after_tool_call`（完成后，`:679`）、`llm_output`（`:957`）——详见 §2.7 L2。

| 失效方向 | 场景 | 机制 | 来源 |
|---|---|---|---|
| **误报** | 一次 10 分钟 `npm test` / 长构建 | 派发时刷新，随后静默直到完成；若单工具耗时 > `stallTimeoutMs`（默认 300s，无预算 run 600s）→ 判停滞 | 审计 3.2 |
| **漏报** | 高频空转（反复读同一批文件、反复跑同一查询） | 每次工具刷新两次，`lastActivityAt` 永不老化 → **永不触发** | v1 缺口 B |

第二个检测器同样有已记载的盲区：`trackToolError`（`src/tool-error-tracker.ts:19-33`）只数**连续完全相同**（同 tool + 同 args）的失败，阈值 3；`A→B→A→B` 交替失败永不触发。注释（`tool-error-tracker.ts:14-17`）明确承认此盲区并把兜底寄托给「其他 breaker」——而「其他 breaker」只剩 turn 计数（见 P0-5）。

**误报的后果链（审计原述的修正）**

审计称误报会「重派一轮，与原 turn 并发改同一工作区」。**该后果不成立**——`kickResumedTurn` 结构上无法启动 turn（见 P0-7 的 host 侧证据）。真实后果是：

1. stall → `retry_queued` → 退避 → `retry_due` → `claimed` + `needsCrossTurnResume: true`（`orchestrator.ts:227-241`）；
2. `kickResumedTurn` 只排注入，**踢不动 turn**；
3. 若渲染进程在线，它看到 `needsCrossTurnResume` 后发 `chat.send`（`autopilot-continuous.ts:96`）——**此时原 turn 可能仍在跑**。双 turn 风险经**这条路径**真实存在：幂等键相同时被 gateway 去重（安全，见 §5.10）；**键不同时会真正并发**——gateway 的 `chat.send` 无任何 session 级串行化，全部在飞守卫都按 `runId`（= `idempotencyKey`）索引（`chatAbortControllers.get(clientRunId)`），故同一 session 的两个不同键会各起一个 turn，同时写同一工作区。**注意**：在 P0-1b 修复前该风险不可达（空消息先被拒绝），修复后即成为真实风险；
4. 若渲染进程离线/降级，run 静默卡死——**这正是 §2.7 观察到的形态**（三次 stall 后 `max_retries_reached`）。

**漏报的后果**

可烧掉 30 轮 × 任意时长 × 任意成本，期间无任何机制介入。业界数据（§3.1）显示「原地打转」在长程失败中占 20–48%，不是边缘情况。

### P0-7（v1 缺口 C）跨轮驱动依赖渲染进程，引擎无法自驱

**实测证据**

`src/stores/autopilot-continuous.ts:95-96` 注释直陈 *"Cross-turn resume: plugin cannot trigger chat.send, renderer must"*。**host 侧证据支持该说法**：

1. `enqueueNextTurnInjection` 只把注入记录写进 session store（host bundle `loader-*.js` 的 `enqueuePluginNextTurnInjection`，纯 map 写入，不派发 turn）；
2. 消费方 `drainPluginNextTurnInjectionContext` 的调用点在 `attempt.prompt-helpers-*.js` 的 `resolvePromptBuildHookResult` 内——即**已被派发的 turn 的 prompt 构造阶段**。注入内容作为 `prependContext`/`appendContext` 拼进 `effectivePrompt`；
3. 故：**装饰一个已在飞的 turn 可以，启动一个新 turn 不行**。若此后无人派发 turn，注入就躺在 store 里直到 TTL 过期被 drain 的 `isExpired` 过滤掉。

**触发条件**

stall 恢复、retry 到期、崩溃恢复——三条路径都靠 reducer 把 run 推到 `claimed`，然后指望 `kickResumedTurn` 开新轮。

**后果**

- `kickResumedTurn`（`index.ts:117-133`）实际踢不动；真正开新轮的是渲染进程的 `chat.send(message:'')`（`autopilot-continuous.ts:131`）；
- 渲染进程连续 3 次 IPC 失败 → 标 `degraded` + toast，**不再自动重试**（`autopilot-continuous.ts:101-114`）→ 长跑静默停摆；
- 崩溃恢复的 `claimed` run **不会**被自动踢（`index.ts:500-503` 注释：kick 推迟到 `enqueueInjectionFn` 就绪），只能等下次 stall/retry tick 或会话重连；
- **v2 印证**：§2.7 的真实 run 正是死在这个形态——`claimed` + `needsCrossTurnResume: true`，然后无人派发 turn，三次 stall 后死亡。

> **v2.1 修正：注释里的「renderer must」是过度推论。**
> 上述 host 侧证据只证明了「**引擎自己**不能启动 turn，必须有 MA 侧组件派发 `chat.send`」——它**没有**证明必须是渲染进程。`autopilot-continuous.ts:95-96` 那句 *"renderer must"* 描述的是当前实现，被 v1 当成了能力边界。
>
> 主进程同样能派发，且三项更优：事件到达更早（`sessions.changed` 先到主进程 `manager.ts:1589` 再转发渲染 `gateway-handlers.ts:615`）、`chat.send` 在主进程侧是**可重放** RPC（`REPLAYABLE_RPC_METHODS`，`manager.ts:212`）、不受窗口隐藏与渲染节流影响。仓内已有同形先例：`electron/utils/todo-executor.ts:180`。
>
> 故 P0-7 的**缺口本身成立**（引擎无法自驱是真的），但 §5.10 的修法从「加固渲染驱动」改为**把驱动移入主进程**——这是根治而非绕过。上面第 2、3 条后果（渲染侧 3 次即 degraded、崩溃恢复不被踢）随之消失。

### P1-8（新增）`resume` 绕过可恢复性守门 ⊕ 可恢复集在生产全不可达

> **v2 新增，合并两条**：这是同一个洞的两面。守门逻辑存在但不可达（N6），而唯一实际生效的 resume 通路不查它（N2）。两份原始报告都断言「非可恢复 blocked 不能 resume」——**都错了**。

**实测证据（其一：RPC 绕过 reducer 守门）**

reducer 侧守门是**正确**的（`orchestrator.ts:349-358`）：

```ts
case 'resume_requested': {
  if (state.orchestrationState !== 'blocked' && state.orchestrationState !== 'unclaimed') return state;
  if (state.orchestrationState === 'blocked') {
    const reason = state.blockedReason;
    if (!reason || !RESUMABLE_BLOCKED_REASONS.has(reason)) {
      return state;            // ← 不可恢复 → no-op，返回原 state
    }
  }
  return { ...state, orchestrationState: 'claimed', blockedReason: undefined, needsCrossTurnResume: true, … };
}
```

但 `autopilot.resume` RPC 在 reducer 之后**无条件**调 legacy setter（`index.ts:1326-1331`）：

```ts
const orchestrated = orchestratorReducer(state, { type: 'resume_requested', runId, now: Date.now() });
const resumed = resume(orchestrated);        // ← 无条件，不看 reducer 是否 no-op
setState(runId, resumed);
kickResumedTurn(runId, resumed);
```

而 `resume()`（`src/autopilot-state.ts:82-97`）只检查 `status`：

```ts
export function resume(state: AutopilotState): AutopilotState {
  if (state.status !== 'paused') { throw new Error(…); }
  const next = { ...state, orchestrationState: 'claimed', blockedReason: undefined,
    enabled: true, pauseReason: undefined, toolErrorCount: 0, lastToolError: undefined,
    needsCrossTurnResume: false, degraded: false };
  return { ...next, status: deriveStatus(next) };
}
```

由于 `deriveStatus` 把**所有** blocked（除 `user_stopped` → `idle`）派生为 `'paused'`（`orchestrator.ts:57-61`），前置 RPC 检查 `state.status !== 'paused'`（`index.ts:1325`）对任何 blocked run 都通过。净效果：

> **除 `user_stopped` 外，任何 blocked run 都能被 resume**——reducer no-op 之后 setter 强写 `claimed` + 清 `blockedReason`。

这违反 ADR-016 的「reducer 是唯一写者」。

**实测证据（其二：可恢复集四个成员全部不可达）**

`RESUMABLE_BLOCKED_REASONS = {stalled, validation_failed, evidence_missing, injection_rejected}`（`orchestrator.ts:28-33`）。穷举所有生产写点：

| 来源 | 写出的 BlockedReason | 是否 resumable |
|---|---|---|
| `decideContinuation` 三处 pause（`continuation-engine.ts:81`/`:85`/`:89`） | `tool_error_repeated` / `token_budget_exceeded` / `max_total_reached`（经 `pauseReasonToBlockedReason`，`types.ts:96-104`） | 全否 |
| `index.ts:1034` `pause(updated, 'max_total_reached')` | `max_total_reached` | 否 |
| `index.ts:1080` `pause(state, 'loop_breaker_triggered')` | `loop_breaker_triggered` | 否 |
| `orchestrator.ts:215`（stall 重试耗尽）、`:293`（evidence 重试耗尽） | `max_retries_reached` | 否 |
| `orchestrator.ts:186` 兜底 | `unrecoverable_error` | 否 |
| `orchestrator.ts:127` `workspace_create_failed` | — | 事件 `workspace_failed` **从不派发**（`orchestrator.ts:117-121` 注释自承） |
| `orchestrator.ts:305` `permission_denied` | — | 事件 `permission_denied` **从不派发**（同上；工具阻断走 host veto） |
| `orchestrator.ts:317` / `autopilot-state.ts:42` | `user_stopped` | 派生 `idle`，不走 resume |

**四个 resumable 成员无一有生产写点**：

- `'stalled'` — 仅出现在 `orchestrator.ts:220` 的 `buildRetryEntry(currentAttempt, 'stalled', …)`，那是 **retry 的 `lastError` 字符串**，不是 `blockedReason`（审计 3.7 的这条判断正确）；
- `'validation_failed'` — 同理只作 retry 错误串（`orchestrator.ts:279`）；作为 blockedReason 仅存在于 `toBlockedReason` 的默认参数，而唯一调用点已显式传 `'unrecoverable_error'` 覆盖（`orchestrator.ts:186`）；
- `'evidence_missing'` — 只在类型联合（`types.ts:31`）、`VALID_BLOCKED_REASONS`（`:55`）、resumable 集（`orchestrator.ts:31`）、恢复 allowlist（`state-persister.ts:432`）出现，**零生产写点**；
- `'injection_rejected'` — 同样只在类型/集合/映射中出现。

**后果**

1. 「可恢复 vs 不可恢复」的区分在生产上**零效果**；reducer 的守门对任何真实 run 都只会 no-op；
2. 实际 resume 通路是越权的 setter，故**用户能 resume 任何死掉的 run**——但 `resume()` **不清 `retry.attempt`**（`autopilot-state.ts:86-96` 只清 `toolErrorCount`），故下一次失败立即 `shouldRetry: false` 再次 blocked。即**假性康复**：能点，点了跑一轮，再死；
3. **对 §5.2 的直接影响**：v1 方案依赖「`evidence_missing` 已在 resumable 集，用户可一键继续」。集合里有 ≠ 会被写入 ≠ resume 会尊重它。故 §5.2 必须扩为三步（见 §5.2）。

### P1-9（新增）degraded 兜底路径丢增量，turn 计数可能永不递增

> **v2 新增**。与 P0-5 叠加：唯一普适刹车在降级模式下可能失效。

**实测证据**

`agent_end` 的 canary 分支（`index.ts:1036-1076`）先算出递增后的状态：

```ts
const continued = incrementTotal(resetTurnAttempts(updated));   // :1039
```

三条出口：

| 出口 | 代码 | 是否递增 |
|---|---|---|
| enqueue 成功 | `:1053-1063` 用 `stateByRun.get(runId)` 重取当前态并 `totalContinuations: current.totalContinuations + 1` | ✅ |
| enqueue 返回 `{enqueued:false}` | 落到 `:1073` `setState(runId, { ...updated, needsCrossTurnResume: true })` | ❌ `updated` 只带 `degraded: true` |
| enqueue 不存在 / 抛错 | 同上 `:1073` | ❌ |

`continued` 在后两条出口被**丢弃**。

**触发条件**

降级模式（`before_agent_finalize` 未触发）+ host 拒绝注入或 `enqueueNextTurnInjection` 不可用。

**后果**

`totalContinuations` 不递增 → `maxTotalContinuations` 永不到达 → 在 P0-5（无墙钟/成本上限）的前提下，**降级模式下的 run 没有任何硬性终止条件**，只能靠 stall 检测（其本身有 P0-6 的漏报盲区）。

### P1-10（审计 3.8）验证命令 maxBuffer 冤杀 verbose 测试

**实测证据**

`src/command-runner.ts:100`：

```ts
execFile(b, a, { timeout: timeoutMs, cwd, shell: useShell }, (error, _stdout, stderr) => {
```

只设 `timeout` / `cwd` / `shell`，**无 `maxBuffer`**。包声明 `@types/node: ^22`，无 `engines` 字段；Node 22 的 `execFile` 默认 `maxBuffer` 为 **1 MiB / 流**（stdout 与 stderr 各自独立）。

`_stdout` 的下划线只是「未使用参数」的 JS 约定，**不影响 Node 是否缓冲**——`execFile` 回调式 API 总是先把两个流缓冲完再回调。故 verbose 的**通过**测试同样会溢出。

**溢出错误无法与真实失败区分**：溢出时 `err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`、`err.killed === false`、`err.signal === null`。而 catch 分支（`command-runner.ts:48-65`）只认超时：

```ts
const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT';
results.push({ status: timedOut ? 'timeout' : 'failed', … });
```

→ `status: 'failed'`，与真实测试失败**同形**。

**后果**

输出量大的合法通过的测试套件 → 判 `failed` → evidence gate 失败 → 白重试到 `maxRetries` → `max_retries_reached` blocked。在 P1-8 的前提下，用户 resume 也只是再死一次。

### P1-11（v1 缺口 E ⊕ 审计 3.10）压缩后上下文只剩计数串；无结构化 plan 工件

**实测证据**

压缩前后只快照 `goal` + `progress`（`src/goal-manager.ts:9-17` → `src/autopilot-state.ts:117-133`）。而 `progress` 的**唯一写入点**是：

```ts
// index.ts:1092-1095
progress: `Turn ${afterOrchestrator.totalContinuations}/${afterOrchestrator.maxTotalContinuations} completed`,
```

**无结构化 plan/todo 工件**：恢复后靠往注入指令里塞 goal + progress 文本让模型自行重建计划（`continuation-engine.ts:106-139`）。

**审计「截断 500 字符」一说需修正**（本次核查）：`MAX_GOAL_LENGTH = 500` 只在 `setGoal()` 调用时生效（`autopilot-state.ts:113-115`）；`buildCheckpoint`/`loadCheckpoint` 对 `goal`/`progress` **不截断**，`progress` 根本没有长度上限。故「恢复材料被截断」不准确——真正的问题是**内容本身贫乏**（一个计数串），而非被截。

**但审计发现的另一条成立**：`restoreGoalFromSnapshot` 优先级不对称（`autopilot-state.ts:125-133`）：

```ts
goal: state.goal ?? state.goalSnapshot,              // 当前优先
progress: state.progressSnapshot ?? state.progress,  // 快照优先
```

`goal` 取当前、`progress` 取快照。`goal` 的优先级有测试记录其意图（`tests/e2e/goal-compaction.e2e.test.ts:191`），`progress` 的反向优先级**无任何注释或测试说明理由**，形似笔误。后果：compaction 恢复后可能新 goal 配旧 progress。

**后果**

模型压缩后拿回的「进展」是 `"Turn 7/30 completed"`——无已改文件、无已完成子任务、无已知失败、无已做决策。叠加 §3.1 的自条件效应与 Governance Decay，长跑后段质量衰减无对冲手段。

### P1-12（v1 缺口 D）长程可观测性近乎为零

**实测证据**

`AutopilotProjection`（`src/projection.ts:5-46`）有 30+ 字段，UI 只渲染 **9 个**，且分散在三个组件：

- `ContinuousModeToggle.tsx`（工具栏）消费 8 个：`status`、`enabled`、`totalContinuations`、`maxTotalContinuations`、`canStop`、`pauseReason`、`lastGoal`、`blockedReason`；
- `degraded` **不在** toggle 里，只被会话列表的状态点用到（`src/components/layout/EmployeeSessionTree.tsx:211`、`src/components/layout/ChatHistory.tsx:119`，仅进 `aria-label`）。

全暗字段（引擎在传、UI 无消费点）：

```
evidenceStatus · evidenceSummary · lastEvidenceCommands · retryCount · nextRetryAt
orchestrationState · runtimeMs · estimatedCostUsd · inputTokensUsed · outputTokensUsed
lastToolError · workspacePath · workspaceBranch · tokenBudget · totalTokensUsed
turnAttempts · maxAttemptsPerTurn · maxConcurrentAutopilot · startedAt · lastActivityAt
thinkingIntensity · modelTier · recommendedModelId · workflowSource · workflowConfigError
```

**触发条件**

任何长跑。长跑 UI 是聊天工具栏一个状态胶囊 + `N/M` 计数（`ContinuousModeToggle.tsx:122-128`）。

> ⚠️ **v2 修正：`src/pages` 无 dashboard 路由是决策，不是缺口。**
> v1 此处原写「无 autopilot dashboard 页面（grep `src/pages` 无对应路由）」，暗示这是遗漏。实测 `git log` 后推翻：面板**存在过并被显式删除**——`347df92a3`（2026-06-10）「feat(autopilot-ui): Apple HIG ConfigPanel + 移除 Dashboard UI（备份至 `origin/symphony`）」删了 `src/pages/AutopilotDashboard/` 12 文件、`/autopilot` 路由、`autopilot-dashboard` i18n 命名空间、约 20 个测试，共 4535 行。同一提交还把 `ContinuousModeToggle` 改成「无 projection 时返回 null（看板入口已移除）」。
>
> 故本条**不再提议恢复面板**（决策见 §8）。字段清单保留在此，供将来重启该决策时评估，不作为待办。

**后果**

用户无法回答「它现在在干什么、验证过了吗、重试几次、烧了多少钱」。P0-4 的「skipped 与 passed 同形」直接源于此。**v2 补充**：§2.7 那个真实 run 的 24 分钟静默停摆，用户在 UI 上只会看到状态胶囊从 `running` 变 `paused`——`retryCount`、`nextRetryAt`、`lastToolError` 全部不可见。

### P1-13（v1 缺口 F）子 agent 扇出对 loop 控制不透明

**实测证据**

oh-my-matrix `docs/design/autopilot-dynamic-workflows-boundary.md` §4 记载的「half-merge」是**故意设计**。本次核查补齐了完整的 hook → lookup 对照表：

| Hook | lookup 函数 | 父 run 看得见 subagent 活动？ |
|---|---|---|
| `before_model_resolve`（`index.ts:798`） | `findRunBySessionOrParent` | ✅ model tier 生效 |
| `llm_output`（`:932`） | `findRunBySessionOrParent` | ✅ token 上卷 |
| `before_agent_finalize`（`:519`） | `findRunBySession` | ❌ continuation 决策看不见 |
| `after_tool_call`（`:672`） | `findRunBySession` | ❌ 工具错误不计入 |
| `agent_turn_prepare`（`:721`） | `findRunBySession` | ❌ |
| `before_tool_call`（`:853`） | `findRunBySession` | ❌ 权限/活动刷新看不见 |
| `agent_end`（`:1021`） | `findRunBySession` | ❌ turn 完成看不见 |
| `before_compaction`（`:701`）/ `after_compaction`（`:711`） | `findRunBySession` | ❌ |
| `session_start`（`:979`）/ `session_end`（`:997`） | `findRunBySession` | ❌ |

即：**只有 token 计量与模型路由上卷，全部生命周期 hook 不上卷。**

**后果**

整个扇出对父 run 是**一次不透明长 turn**：`turnAttempts` 不增、停滞检测看不见内部进展、tool-error breaker 不触发、continuation 计数不前进。业界基准文档自评 3/5 的已知项，非本文新发现。**与 P0-6 的交互**：长扇出正是「单工具/单 turn 超时」误报 stall 的典型场景。

### P1-14（审计 3.6，降级）`released` 是停滞检测盲区 —— 真实风险是 validation 期 TOCTOU

> **裁决：盲区为真，但审计描述的暴露面几乎不存在**；真实风险在另一处，故降级并改写。

**实测证据**

`checkStall` 确实只认 `running` / `claimed`（`stall-detector.ts:31`），`released` 被排除。

**但 `released` 几乎从不落到共享 map**：`agent_turn_finished → evidence_started → evidence_finished` 三个 dispatch 在 `before_agent_finalize` 的 `complete` 分支内**对同一个局部变量 `updated` 连续执行**（`index.ts:622-658`），只在最后一次 `setState`。故巡检看不到处于 `released` 的 run——审计设想的「停在 released 无人管」在当前代码路径下不可达。

**真实风险（本次核查修正）**：`await runValidationCommands(...)`（`index.ts:601-607`）期间，共享 map 里的状态仍是 `running`——**这个状态巡检看得见**。若验证套件耗时超过 `stallTimeoutMs`（每命令默认超时 120s × 多命令，很容易超 300s），则：

1. 巡检判定停滞 → 派发 `stall_timeout` → 覆写状态为 `retry_queued`；
2. 随后 validation 返回，`complete` 分支用**它自己那份早于 stall 的局部快照 `updated`** 调 `setState`；
3. 两者形成 TOCTOU：谁最后写谁赢。

**后果**

长验证套件（正是长程任务的典型）可能被误判停滞，且完成处理器与 stall 处理器互相覆写状态。这与 P0-6 的误报方向同源，但发生在 evidence 阶段而非工具阶段。

### P2-15（v1 缺口 H）无隔离工作区；`workspace.root` 是死配置

**实测证据**

`workspace.root: '.matrix/autopilot-worktrees'`（`src/workflow-config.ts:21`）**从不被消费**——`workflow-config.ts:165` 注释自承：*"workspace.root is not consumed at runtime today (autopilot delegates worktree management to the host per ADR-008)"*。且 `workspace_ready` 事件里 `branchName: ''`、`path = payloadWorkspacePath ?? process.cwd()`（`index.ts:1280`/`1300`）。

**v2 运行时印证**：§2.7 的真实 checkpoint 同时含 `"workspace":{"root":"/Users/…/TestProject","branchName":""}` 与 `"workflow":{"workspace":{"root":".matrix/autopilot-worktrees",…}}`——**两个不同的 `root`，后者纯装饰**。这是「配置项存在但无效」的实物证据。

> ⚠️ **v2 修正**：`state.workspace.root`（activate 填充的真实路径）**不是**死配置——它是 checkpoint 路径的来源（`resolveCheckpointRoot`，`index.ts:207-209`）。死的只是 `workflow.workspace.root`（WORKFLOW.md 里那个）。§5.7 删除时**必须**区分二者，否则会连带破坏 checkpoint 落盘路径。v1 曾把两者混为一谈。

**后果**

autopilot 直接在用户当前 checkout 上改文件。配合 §2.5 的 allow-by-default，一个 30 轮无人值守 run 的爆炸半径就是用户工作目录本身。**配置项存在但无效是最糟状态**——读配置的人会产生虚假安全感。

### P2-16（v1 缺口 I）`hasNoActionableTask` 绕过早停守卫

**实测证据**

`decideContinuation` 中 `hasNoActionableTask` 命中即**立刻** `complete`，**显式绕过** `MIN_TURNS_BEFORE_COMPLETE`（`src/continuation-engine.ts:70-78`，注释自承 "This BYPASSES MIN_TURNS_BEFORE_COMPLETE on purpose"）。模式集在 `src/completion-detector.ts:60-97`，自评为「高精度」（问候语、「没有具体任务」、`nothing to do` 等）。

**触发条件**

真实长任务的模型输出被误判为「无可执行任务」。例如任务本身就在讨论「如何处理无任务场景」，或模型在澄清阶段输出了 `请告诉我具体的需求` 类措辞。

**后果**

run 在第 0 轮即 `complete`（连 2 轮早停守卫都不经过），且因为 evidence 在无命令时是 `skipped`（P0-4），会呈现为一次「正常完成」。这是**唯一能在零轮次内产生 done 的路径**。

**缓解方向**（不在本文方案范围，需另评估）：该绕过对「问候语不该烧 30 轮」是正确的；风险仅在模式精度。可考虑仅在 `totalContinuations === 0` 时允许该绕过——即只对「第一轮就没任务」放行，而非任意轮次。

### P2-17（审计 3.5，后果修正）`isRunStuck` 把正常退避中的 run 判为卡死

**实测证据（触发条件成立）**

`isRunStuck`（`src/autopilot-state.ts:156-166`）对任何 `retry_queued` 一律返回 true（`:162`），**无 `nextRetryAt` 守卫**——正在正常指数退避的 run 也算卡死。且有测试**钉死**该行为：`tests/autopilot-activate-idempotent.test.ts:49-52` 断言 `retry_queued` + `lastActivityAt = NOW` → stuck。

**后果（审计原述被驳回）**

审计称「同一 goal 新旧两 run 并存」。**不成立**：调用点（`index.ts:1268-1284`）先 `stateByRun.delete(oldRunId)` + `sessionKeyToRunId.delete(sessionKey)`，再插入新 run。任一时刻只有一个活跃 run。

真实代价：旧 run 被丢弃时**未走 `stop_requested`、未 `deleteCheckpoint`** → 其 checkpoint 文件泄漏到 24h TTL 清扫（`state-persister.ts` 的 `TERMINAL_CHECKPOINT_TTL_MS`）。

**附带（审计原述成立但已中和）**：`isRunStuck` 的默认参数 `600_000`（`autopilot-state.ts:159`）与 `DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs = 300_000`（`workflow-config.ts:18`）口径不一致。但唯一生产调用点总是显式传值（`index.ts:1252-1254`，来自 `defaultStallTimeoutMs()`），故该默认值只被测试触及。

### P2-18（审计 3.12）正确性/可维护性长尾

| 项 | 证据 | 裁决 |
|---|---|---|
| 修复轮模型 tier 偏低 | `DEFAULT_ROUTING`（`src/model-routing.ts:26-51`）：`totalContinuations <= 1` → `premium`（`initialTurnTier`）；验证期 → `standard`；**其余（含验证失败后的修复轮）→ `defaultTier: 'standard'`**（`:29`） | **成立**——最需要能力的修复轮与普通轮同档，开局轮反而拿 premium |
| ~~验证期 effort 强制 low = 相位倒挂~~ | `effort-injection.ts:51` `if (evidenceStatus === 'running') return 'low'` | **驳回**：验证期跑的是 shell 命令，不是 LLM 推理；注释（`effort-injection.ts:37-44`）明确 "validation phase → low (fast execution)"。审计把「执行脚本」误读为「推理相位」 |
| ~~模型失败无 fallback~~ | `before_model_resolve`（`index.ts:792-828`）只返回 `{modelOverride}` 建议 | **归属错，移出**：本包不拥有模型执行，无从感知调用失败；重试/降档属 host 责任。记入 §8 |
| tool error 熔断 A→B→A→B 盲区 | `tool-error-tracker.ts:14-17` 注释自承；比较逻辑 `:23-26` 要求同 tool + 同 args；不同组合把计数重置为 1（`:31`） | **成立**，见 P0-6 |
| 退避无 jitter | `computeRetryDelay`（`retry-queue.ts:10-14`）纯 `min(10000 * 2^(attempt-1), max)` | **成立**：多 run 同时被限流会同步重试放大冲击 |
| checkpoint tmp 文件崩溃残留无清扫 | 写路径 `${targetPath}.tmp.${pid}.${random}`（`state-persister.ts:181-183`）；`listResumableCheckpoints` 只收 `.json` 且排除 index（`:384`），无 `.tmp.*` 清扫 | **成立**（有测试覆盖正常完成后无残留，但不覆盖崩溃中断） |
| checkpoint 写失败 fail-silent | `state-persister.ts:205-212` 递增 `_writeFailureCount` + `console.error`，外层 `.catch(() => {})` 吞掉 | **成立**：磁盘满时恢复能力静默丢失，仅 `getCheckpointWriteFailureCount()` 可见，无 gateway 暴露 |
| 死 reducer 事件 | `workspace_failed`（`orchestrator.ts:117-121` 注释自承）、`permission_denied`（`:305`，工具阻断走 host veto） | **成立**：定义但从不派发 |
| 非可恢复 blocked 显示 `paused` | `deriveStatus`（`orchestrator.ts:57-61`）把所有非 `user_stopped` 的 blocked 派生 `paused` | **成立**，但后果与审计所述**相反**——见 P1-8：不是「像可恢复但 resume 必拒」，而是「真的能 resume，然后一轮后复死」 |
| 恢复时 `maxConcurrentAutopilot` 硬编码 5 | `state-persister.ts:291`（注释自承 "per-run override not persisted"） | **成立**（P3 级） |
| 恢复时 `toolErrorCount` 归零 | `state-persister.ts:301` | **成立但更安全**：避免临近阈值的 run 一恢复就熔断；属信息丢失非 bug |
| `degraded` 不被序列化，恢复时硬置 `true` | `buildCheckpoint` 无该字段；`loadCheckpoint:300` `degraded: true`（注释 "mark resumed runs"） | **成立**：故 UI 的 `degraded` 在重启后恒真，不代表本次运行降级——§5.9 需标注 |
| maxConcurrent 只在 activate 强制 | `index.ts:1166-1176` 按内存中 `status==='running'` 计数；`register()` 恢复全部 run 时不计数 | **成立**（审计 3.11） |

### P2-19（新增）`sessionKey` 双源仍是自认的未审计面

**实测证据**

`resolveSessionKey`（`index.ts:417-429`）从 `ctx` 与 `event` 两个来源取值，注释自承：

> *"Code-review M1 flagged the dual-source as a foot-gun, but removing the event fallback breaks 8 tests that simulate the production pattern (some hooks only populate sessionKey on event). **Leaving as-is until a deeper audit of per-hook sessionKey provenance is done.**"*

该审计**仍未做**。第三个来源是 `sessionIdToKey`（`index.ts:83`），仅在 `session_start` 时填充（`:969`）。

**与 P0-1 的关系**：sessionKey 解析错位是「hook 拿不到 run」的候选机制之一。§2.7 未能证实或排除它——这正是 P0-1 定位工作第 2 项要查的。

### P3-20（v1 缺口 G）turn 计数回退（≤1 轮）+ 恢复阈值漂移

> v1 原评 P2「崩溃后 turn 计数会回退」，v1 对抗 review 已降级为 P3。v2 维持。

**实测证据**

`shouldCheckpoint`（`index.ts:218-229`）只在 orchState / blockedReason / evidence.status / enabled / goal / progress 变化时落盘，`totalContinuations` **不是**独立触发字段。**但** `progress` 每轮都被改写为 `"Turn N/M completed"`（`index.ts:1092-1095`）→ `prev.progress !== next.progress` 恒成立 → **计数实际每轮都落盘**。故崩溃最多丢当前 turn 的增量（≤1 轮）。

> ⚠️ **v2 补充的脆弱性**：该保护是**搭便车**的。P1-9 已证明存在「不写 `progress` 就 setState」的路径（`index.ts:1073`），此类路径下计数确实不落盘。故 §5.6 的显式触发条件仍有价值。

真正的缺陷是另一条：恢复路径硬编码 `toolErrorThreshold: 5`（`src/state-persister.ts:303`），而默认值是 3（`src/types.ts:334`）→ 恢复后的 run 静默变宽松（错误容忍 3 → 5）。

### 已确认小 bug

| 问题 | 证据 | 影响 |
|---|---|---|
| Settings「安装 Autopilot」必然失败 | `getTgzPath()`（`electron/main/ipc/autopilot-handlers.ts:76-84`）按 `resources/claw-plugin/autopilot/package.json` 的 `3.1.0` 拼 `autopilot-3.1.0.tgz`，但实测只有 `autopilot-3.0.3.tgz` | 仅该按钮路径；正常启动走已解包目录（3.1.0），不受影响 |
| `plugin-registry.json` 硬编码 Windows 路径 | autopilot 条目 `downloadUrl: file:///C:/temp/autopilot-3.0.3.tgz` | 非启动路径；非 Windows 上 `plugin:install` 流会失败 |
| `orchestrator.ts:51` 注释过期 | 称 `deriveStatus` "reference-only"，实际 `index.ts` 15+ 处生产调用 | 误导读者 |
| 动态 i18n key 逃逸静态扫描 | `ContinuousModeToggle.tsx:125`/`:208` 用模板串 `autopilot.pause.${pauseReason}` / `autopilot.blocked.${blockedReason}`；`tests/unit/autopilot/autopilot-i18n-source-invariant.test.ts` 只扫静态 key | 引擎新增 reason 时 UI 显示原始英文 code（有 fallback，不崩） |

### 测试真实性（两级须分开评价）

<details>
<summary>L2 — 引擎侧扎实，UI 侧全 mock</summary>

**引擎侧（好）** — 实测 `npx vitest run`：58 文件 / 861 例，857 passed + 4 skipped，全绿：

- `orchestrator.test.ts`、`continuation-engine.test.ts` = **零 mock** 纯函数测试，构造 state 直接断言 reducer/决策结果；
- `tests/e2e/resilience.e2e.test.ts` 驱动**真实注册的 hook + 真实 `setInterval` 巡检**（fake timers），只 mock host API 外沿（`enqueueNextTurnInjection`/`registerSessionExtension`）——mock 边界划得对；
- 全仓 `tests/` 无 `.only`、无裸 `.skip`（只有 `it.skipIf(process.platform === 'win32')` 这类合理跨平台跳过）、测试内无 TODO/FIXME。

**UI 侧（弱）**：

- `tests/e2e/autopilot/**` 全 8 个文件靠 `page.addInitScript(getAutopilotMockScript())` 注入假 IPC；
- **无任何测试真正跑过一次多轮自主 loop**；
- `tests/e2e/autopilot/autopilot-concurrent-sessions.spec.ts:65` 是明确 `test.skip`；
- 最接近真实的是 `tests/integration/autopilot/autopilot-gateway-registration.test.ts`（调真实 `register()`，但 api 是手搓 mock）。

**v2 关键补充——测试全绿与 P0-1 并不矛盾**：861 个测试覆盖的是**单元与模拟环境下**的 hook 行为。它们无法发现 P0-1（真实 runner 下的 hook 触发问题）与 P0-2（cwd ≠ workspace 的路径不一致），因为：

- 引擎测试用 `_resetForTest` 禁用 checkpoint 持久化，故 P0-2 的路径分歧不可能显现；
- 引擎测试**自己派发** hook 事件（模拟 host），故 P0-1 的「host 是否真派发」被前提化掉了；
- UI e2e 全 mock IPC，故渲染进程驱动链路的真实行为也未被覆盖。

这正是「测试绿 ≠ 功能可用」的教科书案例，也解释了为何两份纯静态审计都没发现 P0-1/P0-2。

</details>

### P3-28（N6-8，新增 2026-08-08）跨轮续行占位消息泄漏进用户可见 transcript

> **2026-08-08 第三轮 code-review 取证**（MA 仓 `MatrixAssistant/electron/utils/autopilot-cross-turn-driver.ts` chat.send 调用处）。P0-1b 的修法是发非空占位 `'[autopilot: next turn]'` 绕过 gateway 的「message or attachment required」——但该串被当作 agent 的 user-turn 输入落进 session 历史 `role:user`，泄漏进用户可见 transcript。

**泄漏链（逐环取证）**：
1. driver 发字面量 `'[autopilot: next turn]'`（MA 侧）；
2. gateway 仅转发，无内容过滤（`packages/gateway/src/manager.ts` `REPLAYABLE_RPC_METHODS` 含 `chat.send`）；
3. openclaw 要求消息非空（`INVALID_REQUEST "message or attachment required"`），故该串成为 agent user-turn 输入，持久化进 session 历史 `role:user`；
4. MA renderer 渲染 `role:user` 为用户气泡（`message-utils.ts` / `ChatMessage.tsx` / `message-group.ts`）。

**后果**：50 轮 run 最多插 50 个英文用户气泡进 transcript；每续轮该串作为 user input 进模型上下文（token 浪费 + 上下文污染）；transcript 类特性（压缩、搜索、evidence）携带 N 份合成消息。zh 用户看英文幽灵气泡。

**裁决：根因在 openclaw 侧**（非空消息要求）。MA 侧 renderer sentinel 过滤纯化妆（原始 transcript/日志仍在）且引入 driver↔renderer 哨兵耦合，**不做**。

**OMM 侧修法**：openclaw 应提供以下之一——
1. **ephemeral / system 续轮 RPC**（不落 user transcript），或
2. **`chat.send` 支持「不持久化」标志位**（`deliver:false` 式，或 `role:'system'`），plugin 侧用该标志发续行信号、不污染用户历史。

当前 plugin 走 `enqueueNextTurnInjection` + MA 侧 chat.send 占位是 P0-1b 后的临时绕行；本项是它的偿债。

### P3-29（N7-4，新增 2026-08-08）crash-recovery 重置 flag × 内存去重 → 网关重启后双花预算

> **2026-08-08 第三轮 code-review 取证**。MA 仓 driver 的幂等键证明（§7）假设「同 key 由 gateway 去重，无双 turn 风险」——但该假设**只在 openclaw server 去重窗内成立**。

**证据**：
- openclaw 去重 Map 是**内存态**（网关重启即清空）、LRU 1000 条、TTL `3e5 ms`（5min，恰等于 plugin `stallTimeoutMs`）；MA 的 24h `processedDedupeHistory` 只覆盖 queued-then-flushed 路径，**不覆盖 direct send**。
- plugin crash-recovery（`dist/index.js:446-450`）重水合 `needsCrossTurnResume=true` 进 `stateByRun`；网关重连后 pull-based projection（`:1027-1050`）重广播带该 flag 的 `sessions.changed` → driver 收到**新鲜 seenAt** → MA 侧 GC 计时器也被重置。
- 故网关重启后，driver 用同 idempotency key 再发 chat.send，但 server 去重 Map 已清空 → **第二个真 turn 跑**（双花模型预算）。且每个重复都 success，failure 熔断永远看不到。

**OMM 侧修法方向**（任一）：
1. crash-recovery 不重置 `needsCrossTurnResume`，改用显式 resume RPC（带原 runId）让 driver/host 协调，避免靠 flag 重广播隐式续行；
2. 去重持久化（跨重启存活）——代价高，可能过重；
3. driver 侧（MA）持久化已发 key 集合跨进程重启——MA 侧缓解，非根因修。

**关联**：MA 侧 P1-22 session GC 的「网关真死」路径由 GC 覆盖（30m+5m），但**「网关重启带降级态」路径（本项）不被 GC 覆盖**——crash-recovery 重广播刷新 seenAt，GC 计时器重置，泄漏存活。MA 文档已标此为 N7-3 的残留。

---

## 5. 方案

### L1 摘要

排序原则（v2 修正）：**先让 loop 真正转起来且看得见**（P0-1/P0-2 是前提），再补「跑不完时能明确停下」（安全网），再补「能真正跑完」（能力），最后补「跑的时候看得见」（可观测）。**复用既有机制优先于新建**——下表每项都标了复用点。

| # | 方案 | 缺口 | 侧 | 复用 |
|---|---|---|---|---|
| 5.0 | **loop 活性定位**（前置） | P0-1 | 引擎+MA | 既有日志设施 |
| 5.1 | checkpoint 根统一 | P0-2 | 引擎 | `resolveCheckpointRoot` |
| 5.2 | 墙钟 + 成本硬上限 | P0-5 | 引擎 | `tokenBudget` 判定形状、`projection.ts:70` 成本公式 |
| 5.3 | 错误分类重做 | P0-3 | 引擎 | omc 的集中式分类表（§3.4 B1） |
| 5.4 | `skipped ≠ passed` + resume 守门修正 | P0-4, P1-8 | 引擎 | `RESUMABLE_BLOCKED_REASONS` |
| 5.5 | 进展台账 | P1-11, P1-13 | 引擎 | `state-persister` 原子写+锁、`permissionAudit` |
| 5.6 | 生产力型停滞检测 + 在飞守卫 | P0-6, P1-14 | 引擎 | 台账（5.5）、`workflow-config` 阈值风格 |
| 5.7 | 中途 Evidence Gate | P0-4 | 引擎 | `runValidationCommands` + `buildFailureBlock` |
| 5.8 | checkpoint 触发与阈值修正 | P3-20, P1-9 | 引擎 | `shouldCheckpoint` |
| 5.9 | 删 `workflow.workspace.root` | P2-15 | 引擎 | — |
| 5.10 | 跨轮驱动移入主进程 | P0-7, P0-1b | MA 主进程 | `todo-executor.ts` 既有形状、`gatewayManager.rpc` |
| ~~5.11~~ | ~~运行面板~~ | ~~P1-12~~ | — | **已撤销**，见 §8（决策：不恢复面板） |
| 5.12 | resume 死按钮修正 + i18n 穷举 + 安装期 bug | P1-8 尾, 小 bug | MA | `canResume` 投影字段、`ACTIVATE_FAILURE_I18N` 模式 |
| 5.13 | 长尾修正集 | P1-10, P2-18, P3-20 | 引擎 | — |
| 5.14 | 存活指示（托盘 tooltip） | P1-12 部分 | MA 主进程 | `updateTrayStatus`（`tray.ts:190`） |

> **v2 范围决策（2026-08-01）**：MA 侧**不做运行面板、不做新 UI 界面**，autopilot 在 MA 侧定位为**后台逻辑 + 异常提醒**。这不是新的范围缩减，而是对 `347df92a3` 删除决策的二次确认（见 §8）。受影响的是 5.11（撤销）与 5.12（重定义），5.10 因此从「渲染主驱 + 主进程兜底」翻转为**主进程单驱动**——见下。

### 5.0 loop 活性定位（P0-1 · 实施前置，非代码方案）

> **（8-08 状态更新）** P0-1b（loop 转不起来的机制根因）已随 §5.10 修复。本节性质因此从「**定位**为什么转不起来」转为「**验证**修复后 loop 真能多轮转 + 排残留（P2-19 sessionKey 双源、`before_agent_finalize` 是否触发）」。步骤 5 分流前置条件变更：不再是「loop 从未转」，而是「loop 机制已修待验证」。

**这不是一个代码方案，而是其余方案的前置条件。** 若 loop 在 MA 的真实 runner 下从未转动，则 5.2 的上限、5.4 的判定、5.6 的检测都是在给不运行的代码加特性。

步骤：

1. **让插件 INFO 可见**：§2.7 已定案——插件 `log()` 写出正常，是 MA 侧 `classifyStdoutMessage` 兜底降级为 `debug`（`manager.ts:678`），再被 INFO 默认级别过滤掉。**最省的两个选项都不需要改代码**：
   - **零代码 A**：诊断期把 MA logger 级别开到 DEBUG（5 月的日志证明一开就能落盘）；
   - **零代码 B**：`AUTOPILOT_LOG_FORMAT=json` + 把关键打点临时改用 `warn()`——stderr 通道已验证通畅（65 行实证）；
   - **一行代码**：`classifyStdoutMessage` 给 `[autopilot]` / `[mem4claw]` 这类插件前缀加一条 `→ info` 规则，使插件日志不再受 DEBUG 过滤影响。这是**推荐做法**，因为它同时修好所有插件的可观测性，而非只给 autopilot 开后门；
   - ⚠️ **不要**改 `packages/autopilot/src/logger.ts` 让 info 走 stderr：该文件有 **DRIFT REFERENCE 约定**（`logger.ts:13-19`，须与 `packages/dynamic-workflows/src/logger.ts` 的安全相关部分保持字节等价），代价远高于上面任一项。

   **没有这一步，任何 loop 诊断都是盲猜**；
2. **打点 `resolveSessionKey` 的每 hook 取值**：记录 `hook 名 / ctx.sessionKey / event.sessionKey / sessionIdToKey 命中`，验证 P2-19；
3. **打点 `agent_end` 的三个早退守卫**：区分「未触发」与「触发但早退」，这是 §2.7 未能定论的分叉点；
4. **真实会话复现**：配 workspace + 发一个需要多轮的任务，观察 `[autopilot]` 日志序列是否出现 `before_agent_finalize` 的痕迹；
5. **按结论分流**：
   - 若 `before_agent_finalize` 确实不触发 → 主循环需改挂 `agent_end`（或 host 侧补 hook 派发），且 5.2 的判定落点必须在巡检；
   - 若触发但 run 匹配失败 → 修 sessionKey 口径（P2-19），其余方案落点不变。

### 5.1 checkpoint 根统一（P0-2）

- **统一为「写什么根，就从什么根读」**。两条恢复路径（`index.ts:493`、`:980`）不能用 `process.cwd()`；
- 但恢复时**还没有 state**，拿不到 `workspace.root`——这是本 bug 的结构性难点。三种可行形态：

  | 形态 | 做法 | 代价 |
  |---|---|---|
  | A（推荐） | checkpoint 落到**与 cwd 无关的固定用户级根**（如 `~/.matrix/autopilot/checkpoints/`），`workspace.root` 仅作为 state 字段保留 | 需迁移既有 checkpoint；跨 workspace 的 run 混在一个目录（用 runId 区分，已是现状） |
  | B | 维护一个用户级「已知 workspace 根」注册表，恢复时逐个扫 | 多一处状态；注册表本身也要落盘 |
  | C | 恢复时同时扫 cwd **与** 上次已知 workspace 根（存在配置里） | 半修，仍会漏掉未记录的根 |

- **强烈建议 A**：它同时消除 P2-15 的「配置项存在但无效」困惑，且与 ADR-008（worktree 归 host）一致——checkpoint 是**引擎自己的**协调状态，本就不该寄居在用户工作区里；
- 迁移：首次启动时若在旧位置（`{workspaceRoot}/.autopilot/checkpoints/`）发现 checkpoint，读取后写到新位置并删除旧文件。需在 CHANGELOG 说明；
- ⚠️ 实施时必须同步 `deleteCheckpoint` / `clearSessionIndexEntry` / `listResumableCheckpoints` / `lookupRunIdBySessionKey` 全部五个调用点（`index.ts:243-249`、`:351`、`:493`、`:980`、`:1008`），漏一个就会出现「写新读旧」的镜像 bug。

### 5.2 墙钟 + 成本硬上限（P0-5）

- `src/types.ts` 的 `AutopilotConfig`/`AutopilotState` 增 `maxDurationMs?`、`maxCostUsd?`；
- 判定逻辑复用现有 `tokenBudget` 的形状（`continuation-engine.ts:84-86`）：

  ```ts
  if (state.maxDurationMs != null && state.startedAt != null
      && now - state.startedAt >= state.maxDurationMs) {
    return { action: 'pause', pauseReason: 'max_duration_reached' };
  }
  if (state.maxCostUsd != null && estimateCostUsd(state) >= state.maxCostUsd) {
    return { action: 'pause', pauseReason: 'max_cost_reached' };
  }
  ```

- ⚠️ **落点修正（v2，重要）**：v1 把主判定放在 `decideContinuation`。但已确认 (a) `before_agent_finalize` 在 API 错误时**不触发**（host 侧核实），(b) P0-1 显示该 hook 在 MA 真实 runner 下的触发本身存疑。故：

  > **主判定必须落在 60s 巡检**（`index.ts:1407-1472`），与 stall 检查并列；`decideContinuation` 内的判定退为**辅助**（快速路径）。

  这也顺带解决 v1 自己指出的「`decideContinuation` 拦不住单个超长 turn」问题——巡检本就是唯一能在 turn 内部介入的位置。
- 新 `PauseReason`：`max_duration_reached`、`max_cost_reached`，映射为**非** resumable（对齐 `token_budget_exceeded`）。**必须同步四处**，漏任一处都会静默降级：

  | # | 位置 | 漏改后果 |
  |---|---|---|
  | 1 | `PauseReason` union（`src/types.ts:3-13`） | 编译错误，会被发现 |
  | 2 | `pauseReasonToBlockedReason`（`src/types.ts:88-105`，**total 映射**） | 编译错误，会被发现 |
  | 3 | `BlockedReason` union（`src/types.ts:26-45`） | 编译错误，会被发现 |
  | 4 | `VALID_BLOCKED_REASONS` Set（`src/types.ts:48-66`） | **静默降级**——`isValidBlockedReason` 返回 false → `toBlockedReason` 回落默认值。⚠️ v1 说会回落到 resumable 的 `validation_failed`；**v2 更正**：唯一调用点已显式传 `'unrecoverable_error'`（`orchestrator.ts:186`），故实际回落到非 resumable。后果比 v1 所述轻，但仍是「reason 丢失、诊断信息变成通用错误」 |

- ⚠️ **与 TENSION 3 的交互**：`pause_requested` 在 `retry_queued` 状态下是 no-op（`src/orchestrator.ts:333-341`，故意设计——recoverable breaker 要能活过一次 pause）。若巡检在 run 处于 `retry_queued` 期间触发硬上限，pause 会被静默吞掉。**硬上限须走一条不受 runningFamily 限制的独立终止事件**，否则上限在整个 retry 窗口内无效；
- 成本公式从 `projection.ts:53-71` 抽成 `src/cost.ts` 纯函数，投影与判定共用，**避免第二套定价常量**；
- ⚠️ 成本判定依赖 host 上报 usage。host 不报时 `totalTokensUsed` 恒 0（已有 `noUsageWarned` 一次性告警，`index.ts:941-944`）——文档须写明「成本上限在 host 不报 usage 时为 no-op」，不可当作硬保证。**§2.7 的真实 run 正是 `totalTokensUsed: 0`**，故这不是理论顾虑；
- **受控收尾**（借 §3.2 的 OpenAI `MaxTurnsExceeded` + fallback 形态）：任一上限触发时，先注入一次「收尾并汇报现状」指令再 pause，而非直接 pause。这让用户拿到的是一份现状摘要而非一个静默停止的 run。

### 5.3 错误分类重做（P0-3）

- `classifyRecoverability`（`retry-queue.ts:22-72`）从子串匹配改为**显式分类表**，借 omc 的集中式豁免清单形态（§3.4 B1）：

  | 类别 | 判据 | 处置 |
  |---|---|---|
  | 限流 | HTTP 429、`rate limit`、`Retry-After` 存在 | 可恢复 + **独立长退避档**（尊重 `Retry-After`） |
  | 服务过载 | 529、`overloaded` | 可恢复 + 长退避 |
  | 网络瞬时 | `ECONNRESET`、`ETIMEDOUT`（**网络层**）、`socket hang up`、`EPIPE` | 可恢复 |
  | 认证 | 401、403 | 不可恢复（需人工） |
  | 上下文超限 | `context_length_exceeded`、`max_tokens` | 可恢复**一次**（触发压缩后重试） |
  | 权限 | `permission` | 不可恢复（保持现状） |
  | 未知 | 其余 | **仍保守判不可恢复**，但记录原始错误串供诊断 |

- 判据优先用**结构化字段**（HTTP status、error code）而非消息子串；只在 host 只给字符串时退化为匹配，且匹配须**锚定**（如 `/^ETIMEDOUT\b/` 而非 `includes('timeout')`）以消除 P0-3 的双向误伤；
- 同步扩大 `RESUMABLE_BLOCKED_REASONS` 覆盖瞬时错误致死的情形，**并配合 5.4 让该集合真正生效**（否则仍是死逻辑）；
- 分级重试指导（借 §3.4 B5）：`buildRetryInstruction` 按 `retry.attempt` 分档——前几次「修复后重试」，达阈值改口「换完全不同的方法或停下汇报」；
- 相同失败检测（借 §3.4 B6）：失败描述归一化（去时间戳/行号）后连续 N 次相同 → 不再退避而转 blocked/换策略；
- 退避加 jitter（P2-18）：`computeRetryDelay` 增 `± 20%` 随机，避免多 run 同步重试放大冲击。

### 5.4 `skipped ≠ passed` + resume 守门修正（P0-4 + P1-8）

> **v2 合并两条**：v1 的 §5.2 依赖「`evidence_missing` 在 resumable 集里，用户可一键 resume」。P1-8 已证明该前提**不成立**（集合成员全不可达 + RPC 不查集合）。故必须三步同做，否则方案承诺的体验不存在。

**第一步：区分 `skipped` 的两种成因**（v1 已收窄的形态，保留）

| `skipped` 成因 | 处置 | 理由 |
|---|---|---|
| **从未配置**验证命令（`commands.length === 0`） | `done` + `completionUnverified: true`（行为不变，仅加标记） | 无测试项目是合法场景，不该被拦 |
| **配置了但没跑成**（命令缺失/超时/被 allowlist 丢弃，即 `commands.length > 0` 却无有效结果） | `blocked` + `blockedReason = 'evidence_missing'` + `completionUnverified: true` | 「本应验证却没验证」才是真风险 |

- 实施点：`orchestrator.ts:261` 的 `evidence_finished` 分支需能区分二者。当前 `evaluateEvidence`（`evidence-gate.ts:27-35`）对「无命令」返回 `skipped` 并附 `failureReason: 'no validation commands configured'`——**不要匹配该字符串**，应新增显式字段（如 `skipReason: 'not_configured' | 'not_executed'`）；
- ⚠️ 注意 `index.ts:619` 的 fail-open 分支也产出 `skipped` + `failureReason: 'evaluation error'`——它属「配置了但没跑成」，应归入 blocked 一侧。

**第二步：让 `evidence_missing` 真正可达**（新增，P1-8）

上表第二行是该 blockedReason 的**首个生产写点**。实施后需验证 `VALID_BLOCKED_REASONS`（已含）与恢复 allowlist（`state-persister.ts:432`，已含）无需改动。

**第三步：让 resume 尊重守门**（新增，P1-8）

`autopilot.resume`（`index.ts:1318-1335`）必须在 reducer no-op 时**停止**，而非继续调 setter：

```ts
const orchestrated = orchestratorReducer(state, { type: 'resume_requested', runId, now });
if (orchestrated === state) {                       // reducer 拒绝了
  respond(false, undefined, { code: 'INVALID_REQUEST',
    message: `cannot resume: ${state.blockedReason} is not recoverable` });
  return;
}
```

并把 `resume()` setter 的职责收缩为「清理副状态」（`toolErrorCount`、`lastToolError`、`degraded`），**不再自行写 `orchestrationState`/`blockedReason`**——那是 reducer 的职责（ADR-016）。同时清 `retry`（否则 P1-8 的「假性康复」仍在）。

- ⚠️ **这是行为破坏性变更**：当前用户能 resume 任何 blocked run；修正后只有可恢复的能 resume。**必须与 5.12「必做 1」同批落地**——否则 resume 按钮仍按 `isPaused` 显示（`ContinuousModeToggle.tsx:168`），而 `deriveStatus` 把不可恢复的 blocked 也派生成 `paused`，用户会得到一个永远点不动的按钮，比现状更糟。CHANGELOG 标 minor 并写明；
- `src/projection.ts` 透出 `completionUnverified` 与 `canResume`（由 `RESUMABLE_BLOCKED_REASONS.has(blockedReason)` 计算）。⚠️ **`canResume` 的消费点是 5.12 必做 1**（替换按钮显示条件）——不做 5.12 则该字段新增即成死字段。`completionUnverified` 在面板撤销后**无渲染消费点**，仅供 5.14 的托盘摘要与将来使用；
- ⚠️ **现有测试影响**（v1 已实测，收窄后大部分已规避）：以下测试断言「无命令 → skipped → done」，本方案保持该行为不变，故**不会**被打断——但 `completionUnverified` 新字段需同步预期：
  - `tests/evidence-wiring.test.ts:86-93`（`evidenceStatus === 'skipped'`）、`:96-103`（`projection.status === 'done'`）；
  - `tests/orchestrator.test.ts:594-603`（`evidence_finished(skipped)` → `status='done'`）；
  - `tests/e2e/lifecycle.e2e.test.ts:150`（no commands ⇒ skipped ⇒ done）。
- 第三步会打断任何断言「非可恢复 blocked 也能 resume」的测试——实施时需 grep `autopilot.resume` 的测试覆盖。

### 5.5 进展台账（P1-11 + P1-13 · 收益最高）

替换 `"Turn N/M completed"` 这个计数串。**这是 P1-11 与 P1-13 的共同根因。**

- 新 `src/progress-ledger.ts`，条目结构：

  ```ts
  interface LedgerEntry {
    turn: number;
    filesTouched: string[];      // 仅写类工具（workspace_write）
    commandsRun: string[];       // 仅执行类（validation / destructive_git / 未分类 exec）
    evidenceStatus?: EvidenceStatus;
    decisions: string[];         // 模型显式声明的决策（可选，先留空）
    openItems: string[];         // 已知未完成项
  }
  ```

- **数据源与其精度边界**（v1 对抗 review 要求澄清，避免实施者误用）：
  - `after_tool_call`（`index.ts:669-696`）带 `toolName` + `params`——这是唯一能拿到**文件路径/命令文本**的地方，`filesTouched` 必须从这里取；
  - `permissionAudit`（`index.ts:886-906`，上限 200 条）**只有** `toolName` / `commandClass` / `cwd` / `outcome` / `reason`——autopilot 构造 entry 时**不填** `commandSummary`（该字段在 `permission-policy/src/types.ts:33` 是 optional）。故它**不能**作为 `commandsRun` 的文本来源，只能作为分类信号；
  - ⚠️ `permissionAudit` 在 `allow` 判定**之前**就为**每一次**工具调用追加条目（`index.ts:903-906` 在 `:910` 的 `if (decision.outcome === 'allow') return` 之前），因此它**包含只读调用**。若把它整体当「命令活动」，纯分析任务会永远显得「有活动」——这正是 §5.6 必须按 `commandClass` 过滤的原因；
  - evidence 结果已在 state，直接取；
- 落盘**复用** `state-persister.ts` 现有的原子 tmp+rename（`:177-184`）+ per-runId Promise 链锁（`:170`）——不新造持久化机制。⚠️ 落盘根须与 5.1 统一后的根一致，否则台账会重演 P0-2；
- 容量控制：保留最近 N 轮明细，更早的**折叠为摘要并替换**（对齐 §3.1 Ghost Context——不能叠加旧摘要）；
- 借 Anthropic 的 feature-list 形态（§3.2）：结构化 JSON 而非 Markdown（模型更不敢乱改），且区分「已完成 / 进行中 / 未开始」三态；
- 消费点两处：`agent_turn_prepare` 的注入（`index.ts:758-783`）与 `buildRetryInstruction`（`continuation-engine.ts:106-139`）都改为吃台账摘要；
- 对齐 Governance Decay（§3.1）：`after_compaction`（`index.ts:708-716`）除恢复 goal 外，须**重新注入**约束与台账摘要，不假设 in-context 约束存活；
- 顺带修 P1-11 的 `progress` 恢复优先级不对称（`autopilot-state.ts:125-133`）——台账落盘后，`progressSnapshot` 的存在意义本身就该重估；
- 对 P1-13 的作用：台账能记录 subagent 扇出期间的工具活动（因为 `after_tool_call` 的 sessionKey 是子会话，需经 `findRunBySessionOrParent` 归并——这是本方案**唯一**需要动 half-merge 边界的地方，且只动**观测**不动权限，不违反既有决策）。

### 5.6 生产力型停滞检测 + 在飞守卫（P0-6 + P1-14）

**两个方向都要修**，因为 P0-6 是双向失效。

**方向一：修误报（在飞守卫）**

- `tool_call` 派发后**抑制** stall 计时，直至 `tool_result` 到达或单工具上限（建议 30min）——即区分「静默」与「等待中」；
- 实施注意：`before_tool_call`（`index.ts:850`）与 `after_tool_call`（`:669`）已成对存在，只需在 state 加 `inFlightToolStartedAt?: number`，巡检见其非空则改用单工具上限而非 `stallTimeoutMs`；
- 同时覆盖 P1-14：`await runValidationCommands` 期间同样置该字段（evidence 也是「在飞的长操作」），消除 validation 期误报与 TOCTOU 覆写；
- ⚠️ 需处理 `after_tool_call` 未到达就崩溃/turn 结束的情形，否则字段悬挂会永久禁用 stall 检测——`agent_end` 与 `before_agent_finalize` 都应清零。

**方向二：修漏报（生产力检测）**

- **保留**纯静默检测（`checkStall` 不动），新增「有活动但无产出」判定；
- 判定对齐 §3.1 的 **Dead Step** 定义：连续 N 轮（建议 3）台账中零 `filesTouched` 且零新 `commandsRun` → `pause('no_progress')`；
- **「零新 commandsRun」必须先锁定语义**（v1 对抗 review 阻断项之一）：判定输入**只能**是按 `commandClass` 过滤后的执行类活动（`validation` / `destructive_git` / 未分类 exec），**不能**是 `permissionAudit` 全量——后者含只读调用，会让该检测在分析任务上永不触发。**过滤规则须先锁定，再实现检测**；
- 借 §3.4 B3 的 fail-open 原则：台账读不出时**不**判 no_progress，避免误杀；
- 这正面回答 `tool-error-tracker.ts:14-17` 自承的盲区，并顺带覆盖 `A→B→A→B` 交替失败；
- 阈值沿用 `workflow-config.ts` 的「YAML 前言可配 + 默认常量」风格；
- ⚠️ 误报风险：纯分析型任务（只读代码、只输出结论）天然零文件变更、零执行类命令——它会**命中**本判定。缓解：`no_progress` 归入 resumable（配合 5.4 第三步，此时 resumable 才真正有意义）；N 不宜小于 3；必要时允许算子按任务类型关闭。这是「误停一个分析任务」与「放任一个死循环烧 30 轮」之间的取舍，选择前者。

### 5.7 中途 Evidence Gate（P0-4 放大因素）

- `index.ts:603` 的 `runValidationCommands` 从「只在 `complete` 分支跑」改为「每 N 轮 + `complete` 跑」；
- **复用**现有 `runValidationCommands` + `evaluateEvidence`，不新造执行路径；
- 中途失败**不 block**，只把 stderr 经已有的 `buildFailureBlock`（`continuation-engine.ts:157-183`）回注下一轮——把「最后才发现全错」变成「早期纠偏」；
- 按 **turn 数**而非时间节流（validation 可能很慢，按时间会在慢命令上叠加）；
- ⚠️ 与 5.2 的成本上限相互作用：中途 validation 也耗时，N 太小会显著拉长总时长。建议 N ≥ 5 且可配；
- ⚠️ 与 5.6 方向一的依赖：中途 validation 会拉长「在飞」时间，**必须**先有在飞守卫，否则中途 gate 本身会触发 stall 误报。**实施顺序：5.6 先于 5.7。**

### 5.8 checkpoint 触发与阈值修正（P3-20 + P1-9）

- `shouldCheckpoint`（`index.ts:218-229`）加 `if (prev.totalContinuations !== next.totalContinuations) return true;`——不再依赖 `progress` 搭便车（P3-20 的脆弱性）；
- 修 P1-9：`agent_end` canary 分支的两条丢增量出口（`index.ts:1073` 的 fall-through）改为写 `continued` 而非 `updated`。⚠️ 注意 enqueue 成功分支用的是「重取当前态 + 手动 +1」（`:1053-1063`），修正后三条出口的递增语义须一致，建议统一为重取模式避免覆盖并发变更；
- `state-persister.ts:303` 的硬编码 `toolErrorThreshold: 5` → 持久化真实值并在缺失时回落到 `types.ts` 的默认常量（消除 3/5 静默漂移）；`maxConcurrentAutopilot: 5`（`:291`）同理；
- 补 `.tmp.*` 残留清扫（P2-18）：`listResumableCheckpoints` 扫目录时顺带删除超过 TTL 的 tmp 文件；
- checkpoint 写失败从 fail-silent 改为**可观测**（P2-18）：`_writeFailureCount` 经投影透出，UI 在非零时明确告警「恢复能力已失效」；
- ⚠️ 落盘频率上升（每轮一次）。可接受：`totalContinuations` 每轮最多变一次，远低于 `agent_activity` 的频率，且写入已有 per-runId 锁与原子 rename。

### 5.9 删 `workflow.workspace.root`（P2-15）

> ⚠️ **v2 关键更正**：v1 写「删 `workspace.root`」并声称「checkpoint 路径行为不变」。这**混淆了两个同名字段**。必须区分：

| 字段 | 用途 | 处置 |
|---|---|---|
| `state.workspace.root`（`index.ts:1280`/`:1300` 填充） | **checkpoint 落盘根**（`resolveCheckpointRoot`，`:207-209`） | **不能删**——但若采纳 5.1 形态 A，它将不再参与 checkpoint 路径，退化为纯信息字段 |
| `workflow.workspace.root`（`workflow-config.ts:21`，WORKFLOW.md 可配） | **从不被消费**（`workflow-config.ts:165` 注释自承） | **删这个** |

- 删除范围：配置项本身 + `parseAutopilotSection` 中对应分支与 `..` traversal 校验（`workflow-config.ts:170-177`）+ `DEFAULT_WORKFLOW_CONFIG.workspace.root`（`:21`）；
- 文档明确「autopilot 在当前 checkout 就地工作，隔离由 host 按 ADR-008 负责」，消除虚假安全感；
- ⚠️ 实施顺序：**5.1 先于 5.9**。若先删配置再改 checkpoint 根，中间态会出现路径歧义。

### 5.10 跨轮驱动移入主进程（P0-7 + P0-1b · MA 主进程）

> **v2 翻转（2026-08-01）**：v1 方案是「渲染进程主驱 + 主进程兜底」的双驱动加固。范围决策「MA 侧只做后台逻辑」落定后，改为**主进程单驱动**，渲染层退出驱动链路。这不是妥协——它**根治 P0-7**（跨轮驱动依赖渲染进程）而非绕过，并连带消除 P0-1b 与双驱动的键一致性前提。

**前提认知**：`enqueueNextTurnInjection` 结构上无法启动 turn（P0-7 有 host 侧证据），必须由外部派发 `chat.send`。v1 认为「渲染进程驱动是 host 能力边界」——**这半句错了**：能力边界要求的是「某个 MA 侧组件派发」，不是「渲染进程派发」。主进程同样能派发，且更适合。

**主进程能承担驱动的三条实测依据**

| 依据 | 出处 |
|---|---|
| `sessions.changed` **先到主进程**再转发渲染——主进程拿到投影不比渲染层晚 | 订阅在 `packages/gateway/src/manager.ts:1589`；转发在 `electron/main/ipc/gateway-handlers.ts:615` |
| 主进程可直接发 RPC | `gatewayManager.rpc()`，`packages/gateway/src/manager.ts:1351` |
| `chat.send` 是**可重放** RPC——断线时按 `idempotencyKey` 排队重放，渲染层**没有**这个能力 | `REPLAYABLE_RPC_METHODS = new Set(['chat.send'])`，`manager.ts:212`；排队路径 `:1352-1357` |

**仓内已有同形先例，照抄即可**：`electron/utils/todo-executor.ts` 就是「主进程后台执行器」——`gatewayManager.rpc('chat.send', chatParams, 180000)`（`:180`）自行派发 turn，`notifyRenderer('todo:task-completed', ...)`（`:485`）把结果推给渲染层弹提示，并自带去重窗口（`:474-479`）。autopilot 的跨轮驱动是同一形状，不需要新架构。

**实施要点**

- 驱动器落在主进程，订阅 `sessions.changed`（或复用 `gateway-handlers.ts` 既有分发点），`needsCrossTurnResume` 为真时发 `chat.send`；
- **幂等键沿用现有构造**：`autopilot-cross-${sessionKey}-${totalContinuations}`（原渲染侧 `autopilot-continuous.ts:129`）。键的构造迁移到主进程，渲染侧删除；
- **删除渲染侧驱动**：`autopilot-continuous.ts:101-114` 的「3 次即永久 degraded」连同 `:129-142` 的 `chat.send` 调用一并移除。**P0-1b 的四跳 bug 随之消失**（空消息被 gateway 拒绝 → 主进程返回 `{success:false}` 不抛 → 渲染侧 `.then()` 误判成功 → 失败计数器永不递增），不需要单独修；
- 崩溃恢复的 `claimed` run 在 `enqueueInjectionFn` 就绪后主动补一次 kick（`index.ts:500-503` 的 TODO 语义），而非等 tick；
- 非空消息体：gateway 对空 `message` 直接拒绝（`build/openclaw/dist/chat-CYQVDnLG.js` 偏移 72116，`"message or attachment required"`），故主进程必须发非空占位文本。

**单驱动消掉了什么**

v1 双驱动方案的安全性建立在「两侧幂等键逐字一致」上，并附了 ⚠️「任何一侧改动键的构造方式都会立刻打开双驱动缺口」。**单驱动后该前提整体消失**——只有一处构造键的代码。

但 gateway 的去重作用域边界仍需记录（它约束的是 5.6，不再约束本方案）：

- `chat.send` 的两道在飞守卫全部按 `clientRunId`（= `idempotencyKey`）索引，**不按 sessionKey**——结果缓存（`chat-CYQVDnLG.js:1848-1852`，`clientRunId = p.idempotencyKey` 见 `:1814`）与 `chatAbortControllers`（`:1853-1861`）；
- gateway **没有** session 级串行化：`createChatRunRegistry.add()` 对同一 session 只追加不拒绝（`server-chat-state-B4ta4USz.js:3-8`）；
- 故**键不同 → 真并发**（两个 turn 同写一个工作区）这一格依然存在，只是单驱动下不再由「两个驱动者」触发，而只能由 5.6 的 stall 误报在 `totalContinuations` 已变后触发。

⚠️ **5.6 不再是 5.10 的前置（v2.1 已论证解除）。** v1 结论「5.6 必须先于 5.10」建立在双驱动前提上。单驱动后实测四个 `incrementTotal` 写点全在 turn 完成路径、stall/retry 分支不改 `totalContinuations`，故 stall 误报时幂等键不变、被 gateway 去重。**完整论证见 §7「实施顺序」**。结论：MA 侧可与引擎侧并行开工。

⚠️ **但该结论有成立条件**：幂等键必须继续从 `totalContinuations` 派生。改成时间戳/随机数/独立序号则论证失效、5.6 重新成为前置——**迁移时须在代码注释锚定**。

### ~~5.11 运行面板~~ —— 已撤销（2026-08-01）

**不做。** 范围决策：MA 侧 autopilot 定位为后台逻辑 + 异常提醒，不新增 UI 界面。

这不是新的取舍，而是**对既有删除决策的二次确认**——面板存在过并被 `347df92a3` 显式删除（详见 §4 P1-12 的 v2 修正框与 §8）。v1 提议恢复它，是因为只 grep 了当前代码、没查 `git log`，把「被删」误判为「缺失」。

被撤销内容与替代出口见 §8；P1-12 因此标记为**已知接受**（accepted-as-is），不再有对应方案。

### 5.12 resume 死按钮修正 + i18n 穷举 + 安装期 bug（MA）

> **v2 重定义**：v1 此节叫「UI 接线修正」，但实测四条里只有一条真属 UI。面板撤销后重新拆分——两条随面板撤销，两条与面板无关须保留，另新增一条 v1 遗漏的必修项。

**必做 1：resume 死按钮（新增，5.4 第三步的强制配套）**

v1 把 5.4 的破坏性交给面板兜底（原文：「须配合 5.11/5.12 让 UI 明确区分」）。面板撤销后，这条**不能跟着撤销**——实测表明不修会比现状更糟：

- resume 按钮的显示条件只有 `isPaused`（`ContinuousModeToggle.tsx:168`）；
- 而 `deriveStatus` 把**不可恢复的 blocked 也派生成 `paused`**（`orchestrator.ts:60`，即审计 3.12 的「死胡同状态」）；
- 故 5.4 第三步落地后：按钮照常显示 → 用户点击 → RPC 明确拒绝 → `handleResume` 的 `.catch` 弹一句泛化的 `autopilot.error.resumeFailed`（`:105`）→ run 不动。**用户得到一个永远点不动的按钮。**

修法**不需要面板**，一处条件替换：把 `isPaused` 换成 5.4 已要透出的 `canResume`（`RESUMABLE_BLOCKED_REASONS.has(blockedReason)` 计算）。不可恢复时按钮直接不渲染，而 `blockedReason` 那行**已经在渲染**（`:207-209`），用户看到的是终止原因而非死按钮。这也让 `canResume` 有了真实消费点，不至于新增即死字段。

**必做 2：`PauseReason`/`BlockedReason` 穷举 i18n 映射（与面板无关，属跨仓契约）**

当前是动态拼 key：

```ts
t(`autopilot.pause.${pauseReason ?? 'unknown'}`, pauseReason ?? 'paused')     // ContinuousModeToggle.tsx:125
t(`autopilot.blocked.${projection.blockedReason}`, projection.blockedReason)  // :209
```

引擎（OMM 仓）新增 reason 时 MA 侧**编译期完全无感**，运行时把原始 code 甩给用户（如界面上出现 `max_retries_reached`）。改为穷举映射对象（照 `autopilot-send.ts:126-130` 的 `ACTIVATE_FAILURE_I18N` 模式），使跨仓漏配在类型检查/测试期暴露。

⚠️ 5.2 新增两个 `PauseReason`、5.4 让 `evidence_missing` 首次可达——**三处都必须同步此映射**，否则新状态在 UI 上显示为裸 code。

**必做 3：安装期两个 bug（主进程/资源层，与 UI 无关）**

- `getTgzPath()`（`electron/main/ipc/autopilot-handlers.ts:76`）版本错配——补 3.1.0 tgz，或让 `autopilot:install` 直接从已解包目录装；
- `resources/plugins/plugin-registry.json:6` 写着 `"downloadUrl": "file:///C:/temp/autopilot-3.0.3.tgz"`——**Windows 临时路径进了发布资源，且版本停在 3.0.3**（引擎已 3.1.0）。同文件 `:16` 的 test-matrix-plugin 同病。三处读该文件：`electron/utils/host-plugin-loader.ts`、`electron/utils/plugin-registry-reader.ts`、`electron/utils/plugin-installer/registry-resolver.ts`；
- `orchestrator.ts:51` 过期注释（引擎侧，随 5.13 一起）。

**随面板撤销（不做）**

- ~~未配置 workspace 时的收口~~：v1 要把「无 workspace → evidence 必然 skipped」升级成用户可见的完成态差异，但**显示位置就是面板**。退回现状——`ChatInput.tsx:855` 已调 `detectWorkspaceValidationGap`（实现 `autopilot-send.ts:172`）并弹 toast，保持原样。⚠️ 与 P0-2 的取舍（配 workspace 则验证有效但崩溃不可恢复）在 5.1 落地前**只剩这条 toast 提示**，不再有面板说明；
- ~~`ContinuousModeToggle` 补 `workspacePath`~~：`handleToggle`（`:62-65`）当前不可达。v1 称其为「防御性清理」，但成因现已查明——正是 `347df92a3` 把 `ContinuousModeToggle` 改成「无 projection 时返回 null（看板入口已移除）」所致。它是删除决策的残留死代码，不是待修正确性问题。保持死代码状态，不补参数、不抽 `useAutopilotWorkspacePath()`。

### 5.13 长尾修正集（P1-10 + P2-18 + P3-20）

| 项 | 修法 |
|---|---|
| maxBuffer 冤杀（P1-10） | `command-runner.ts:100` 显式设 `maxBuffer`（建议 10 MiB）**并**区分溢出错误：`err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` 时归为独立状态（如 `'output_overflow'`）而非 `'failed'`，避免与真实测试失败同形。更彻底的做法是改 `spawn` + 流式聚合，只保留尾部 N KB |
| 修复轮 tier 偏低（P2-18） | `model-routing.ts` 增相位判定：`evidence.status === 'failed'` 后的修复轮升 `premium`。当前 `initialTurnTier` 给开局轮 premium 而修复轮拿 `defaultTier`，属倒挂 |
| 死 reducer 事件（P2-18） | 二选一：派发它们（`workspace_failed` 在 activate 校验失败时、`permission_denied` 在 host veto 后），或删除并在注释说明「工具阻断走 host veto，不经 orchestrator」。**不要留着不派发** |
| legacy setter 收尾（W1a） | 5.4 第三步已收缩 `resume()`；`pause()` 同理应改为纯 reducer dispatch。这是 fix-checklist 的 W1a，本文的 5.4 完成了其中最危险的一半 |
| `isRunStuck` 退避守卫（P2-17） | 加 `nextRetryAt` 在未来则不判 stuck；同步改 `tests/autopilot-activate-idempotent.test.ts:49-52`（该测试钉死了当前行为）；旧 run 丢弃前补 `deleteCheckpoint` 消除泄漏 |

### 5.14 存活指示：托盘 tooltip（P1-12 的部分替代 · MA 主进程）

> **v2 新增（2026-08-01）**，配合 5.11 撤销。

面板撤销后，26 个暗字段里绝大多数可由「异常时提醒」覆盖——唯独一个不行：**「它还活着吗」**。这是**主动查询型**问题（用户想看时去看），提醒是被动推送，覆盖不了。长跑场景下这是第一位的问题，优先于成本、优先于验证状态。

出口不必是界面。托盘已有现成设施：`updateTrayStatus(status: string)`（`electron/main/tray.ts:190`）直接改 tooltip，且驱动器就在主进程（5.10），数据不需要跨进程搬运。

- 悬停可见：运行状态 + `N/M` 轮次 + 距上次活动时长（`lastActivityAt`）；
- 无活跃 run 时恢复默认 tooltip（`tray.setToolTip(t('tray.tooltip'))`，`:176`）；
- 多 run 并发时显示聚合（如「Autopilot · 2 个运行中」），不逐个展开——tooltip 不是列表；
- ⚠️ 不引入定时器专门刷新：搭 5.10 驱动器已有的 `sessions.changed` 处理即可。tooltip 停在「3 分钟前活动」本身就是有效信息（**它不动 = 引擎没事件 = 可能真卡了**），比伪造的实时跳动更诚实。

**明确不做**：托盘菜单不加 autopilot 操作项（stop/resume 留在 `ContinuousModeToggle`），否则就是把面板搬进托盘。

**异常提醒（配套，非独立方案）**：5.10 的主进程驱动器照 `todo-executor.ts:485` 的 `notifyRenderer` 形状，在停滞 / 终止 / 预算触顶时推消息给渲染层弹 toast。`todo-executor.ts:474-479` 的去重窗口一并照抄——长跑异常容易连续触发，不去重会刷屏。

---

## 6. 测试策略

- 每条新逻辑配**纯函数测试**，照 `orchestrator.test.ts`/`continuation-engine.test.ts` 的零 mock 风格：5.2 的两个上限判定、5.3 的分类表（每类别一例 + 双向误伤回归）、5.4 的 `skipped` 分支与 resume 守门、5.5 的台账折叠、5.6 的 `no_progress` 与在飞守卫、5.8 的 checkpoint 触发；
- **P0-2 需要真实文件系统测试**（不能 mock）：在临时目录里以 `cwd ≠ workspaceRoot` 保存 checkpoint，再模拟进程重启并断言恢复成功。当前引擎测试用 `_resetForTest` 禁用持久化，故这类测试需单独开一个不禁用持久化的套件——**这正是 P0-2 逃过 861 个测试的原因**；
- **P1-9 需要降级路径测试**：mock `enqueueNextTurnInjection` 返回 `{enqueued:false}` 与抛错两种，断言 `totalContinuations` 递增；
- **P1-10 需要溢出测试**：构造输出 > maxBuffer 的**成功**命令（`node -e "console.log('x'.repeat(2e6))"`，退出码 0），断言不被判 failed；
- 补目前**完全缺失**的真实多轮 loop 集成测试：真实 gateway + 真实插件，覆盖 ≥3 轮自主推进 + 一次 evidence 失败重试 + 一次 pause。**这是 P0-1 的根本防线**——若这个测试存在，P0-1 不会到今天才被发现；
- 解掉 `tests/e2e/autopilot/autopilot-concurrent-sessions.spec.ts:65` 的 `test.skip`；
- 5.6 须专门测**误报**：纯分析型任务（只读、无写）不应被判 `no_progress`；长工具（超 `stallTimeoutMs`）不应被判 stall；
- 5.10 须测**主进程单驱动**：`needsCrossTurnResume` 为真时主进程发出 `chat.send` 且**渲染层不再发**（回归——防止旧驱动残留造成双发）；断线重连后按 `idempotencyKey` 只重放一轮（`REPLAYABLE_RPC_METHODS`，`manager.ts:212`）；消息体非空（否则被 gateway 拒绝）；
- 5.12 必做 1 须测：`blockedReason` 不可恢复时 resume 按钮**不渲染**、`blockedReason` 文案仍渲染——这是 5.4 破坏性变更的唯一用户可见出口，`tests/unit/autopilot/continuous-mode-toggle.test.tsx` 是落点；
- **回归基线**（实施前后须一致，2026-07-31 实测）：`cd oh-my-matrix/packages/autopilot && npx vitest run` → `Test Files 58 passed (58)` / `Tests 857 passed | 4 skipped (861)`。预期变动：5.4 涉及 4 条 `skipped→done` 断言的新字段预期 + resume 守门相关；5.13 涉及 `autopilot-activate-idempotent.test.ts:49-52`。其余不应有变化。

---

## 7. 迁移与兼容

| 项 | 处理 |
|---|---|
| 新增 state/config 字段 | 全 optional，旧 checkpoint 可直接读（`loadCheckpoint` 已对缺失字段有默认，`state-persister.ts:278-311`） |
| **checkpoint 位置变更（5.1）** | **需迁移**。首次启动时从旧位置（`{workspaceRoot}/.autopilot/checkpoints/`）读取并搬到新位置后删除旧文件。⚠️ 但注意：正因为 P0-2，旧位置的 checkpoint 目前**根本读不到**——迁移代码需显式扫描候选根（当前 cwd + 已知 workspace 路径），否则迁移本身会漏。CHANGELOG 标 minor |
| `skipped` 行为变更（5.4 第一步） | 「从未配置命令」保持 done（仅加 `completionUnverified` 标记）→ 文档/分析类任务**仍可无人值守完成**；只有「配置了命令却没跑成」从静默 done 变 resumable pause。CHANGELOG 标 minor |
| **resume 行为变更（5.4 第三步）** | **行为破坏性**：当前用户能 resume 任何 blocked run（P1-8），修正后只有可恢复的能 resume。用户会感到「以前能点现在不能点」。**必须与 5.12 必做 1 同批**——把按钮显示条件从 `isPaused` 换成 `canResume`，使不可恢复时按钮不渲染、只显示既有的 `blockedReason` 文案（`ContinuousModeToggle.tsx:207-209`）。⚠️ 这是本文唯一会**减少**用户可用操作的变更，需产品确认。**v2 注**：v1 此处依赖 5.11 面板显示终止原因，面板撤销后改由上述一行条件替换承担，用户可见性不降低 |
| 用户体验说明（5.4 收窄后） | docs-only / 纯分析 run：完成态显示「未验证完成」，**不打断**无人值守；配了 `npm test` 但命令消失/超时的 run：暂停并提示「本应验证却未验证」，一键 resume（此时 resume 真正有效） |
| 删 `workflow.workspace.root`（5.9） | ⚠️ **两个同名字段，勿混**：删的是 **`workflow.workspace.root`**（WORKFLOW.md 配置项，运行时确实不消费——`workflow-config.ts:165` 注释自承），删除无运行时影响；但 WORKFLOW.md 里写了该字段的用户会收到 "Unknown field" 警告（`workflow-config.ts:131-135`），属预期。**绝不可动 `state.workspace.root`**（`index.ts:208` 的 checkpoint 根、`:879` 的 workspaceRoot）——那是 P0-2 的核心，误删即毁掉持久化 |
| **可观测性收缩（5.11 撤销）** | 无迁移动作，因为面板早已不存在（`347df92a3`，2026-06-10）。用户视角**零变化**。记录于此仅为说明：P1-12 列出的 26 个暗字段在本轮后仍不可见，仅 `lastActivityAt` 等经 5.14 托盘 tooltip 部分可见 |
| 新 `PauseReason` | UI 侧 5.12 的穷举映射必须同步，否则显示原始 code |
| 错误分类变更（5.3） | 之前落 `unrecoverable_error` 的限流/网络错误将改为可恢复 → 这些 run 会自动重试而非死亡。属**行为改善**，但会让「run 存活更久」，与 5.2 的上限须一并上线，否则失去刹车 |
| ADR | 实施时在 oh-my-matrix 补 **ADR-021（编号待定）**（记录 5.2 上限、5.4 evidence 门与 resume 守门、5.1 checkpoint 根三个决策）。⚠️ **8-06/07 更新**：ADR-020 已被 reducer sole-writer（`cross_turn_degraded` / `cross_turn_resume_consumed`）占用，原"本文不占用该编号"前提失效，5.x 决策须另起 ADR-021 |

### 改动落在哪个仓（实施前必读）

本文的方案**主体在 oh-my-matrix，不在 MatrixAssistant**。三侧分布：

| 仓 / 位置 | 方案 | 说明 |
|---|---|---|
| **oh-my-matrix `packages/autopilot/`** | 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.13（**10 项**，全部 P0/P1 核心） | 引擎源码的唯一真实位置。ADR-021（编号待定）也落这里（该仓已有 ADR 014–020；ADR-020 已用于 reducer sole-writer，非 5.x 决策）。回归基线：`cd oh-my-matrix/packages/autopilot && npx vitest run` |
| **MatrixAssistant**（本仓） | 5.10, 5.12, 5.14，及 5.0 的日志采集级别修复（**4 项**，全为消费侧，**无新 UI 界面**） | **v2 范围调整**：MA 侧定位为后台逻辑 + 异常提醒。5.11 已撤销。按层分布：**主进程** = 5.10 跨轮驱动器 + 5.12 必做 3（`electron/main/ipc/autopilot-handlers.ts:76`、`resources/plugins/plugin-registry.json:6`）+ 5.14 托盘 + 5.0 日志（`classifyStdoutMessage`）；**渲染层** = 5.12 必做 1（`ContinuousModeToggle.tsx:168` 一行条件）+ 必做 2（i18n 穷举映射）。⚠️ **P0-1b 不再单独修**——渲染侧驱动整体删除后该 bug 随之消失（见 5.10） |
| **openclaw host** | **无需改动** | P0-1b 的空消息守卫虽在 host（`build/openclaw/dist/chat-*.js`），但从 MA 侧发非空占位即可绕过，无需碰 host。⚠️ MA 运行的是 `build/openclaw/` **构建产物**，源码在另一处（`社区工程/openclaw`）——改 host 需走上游 + 重新构建，成本远高于 MA 侧改一行 |

⚠️ **引擎改动不会自动到 MA**：MA 的 `resources/claw-plugin/autopilot/` 是 `@oh-my-matrix/autopilot` 的**构建产物副本**（name/version 与源码 `package.json` 完全一致，当前均为 3.1.0）。故引擎侧每次改动后必须：

1. `cd oh-my-matrix/packages/autopilot && pnpm run build && pnpm pack`；
2. 把产出的 tgz 与解包目录重新 vendor 进 `MatrixAssistant/resources/claw-plugin/`；
3. 同步 `plugin-registry.json` 与 `getTgzPath()` 期望的版本号。

**当前状态即为该流程缺自动化的证据**：解包目录是 3.1.0，而 tgz 只有 `autopilot-3.0.3.tgz`（见 §4「已确认小 bug」）。建议实施时顺手加一个同步脚本，否则每轮引擎改动都会重现这个错配。

### 实施顺序（依赖约束）

方案间有硬依赖，乱序会产生中间态 bug：

```
5.0（loop 活性定位）
  └─→ 决定 5.2 判定落点、是否需改主循环挂点
5.1（checkpoint 根统一）
  ├─→ 5.5（台账落盘复用同一根）
  └─→ 5.9（删死配置）
5.3（错误分类）+ 5.2（上限）必须同批
  └─ 否则「更能活」而「无刹车」
5.6（在飞守卫）
  └─→ 5.7（中途 gate 会拉长在飞时间）
5.10（主进程单驱动）—— 不依赖 5.6，可与引擎侧并行（论证见下）
5.4 三步 + 5.12 必做 1 同批
  └─ 否则 resume 按钮变成永远点不动的死按钮（比现状更糟）
```

**`5.6 → 5.10` 的前置关系已解除（v2.1 论证，实测取证）**

v1 结论「5.6 必须先于 5.10」建立在**双驱动**前提上：两个驱动者若用不同幂等键，就会在同一 session 起两个 turn。5.10 翻转为主进程单驱动后重新论证——**依赖解除**，依据是幂等键的构造方式：

键为 `autopilot-cross-${sessionKey}-${totalContinuations}`（`autopilot-continuous.ts:128-129`，构造随驱动器迁入主进程）。要产生双 turn，必须让**同一个 run 在跨轮未完成期间**发出两个**不同**的键——即 `totalContinuations` 在此期间递增。实测该计数的全部四个写点，**没有一个在 stall/retry 路径上**：

| `incrementTotal` 调用点 | 所在路径 |
|---|---|
| `index.ts:438` | `buildCrossTurnReviseFallback`——cross_turn 降级为 revise |
| `index.ts:553` | `decideContinuation` 的 `revise` 分支 |
| `index.ts:567` | `decideContinuation` 的 `cross_turn` 分支 |
| `index.ts:1039` | `agent_end` canary 分支 |

四者全部位于 **turn 完成路径**（`before_agent_finalize` / `agent_end`）。而 reducer 的 `stall_timeout`（`orchestrator.ts:205`）与 `retry_due`（`:230`）分支**都不碰 `totalContinuations`**。

故 stall 误报时计数不变 → 键相同 → 落入 gateway 的去重（结果缓存 `chat-CYQVDnLG.js:1848-1852` 或在飞守卫 `:1853-1861`），**只驱动一轮**。而计数一旦递增，说明上一个 turn 已经完成——不存在「两个 turn 同时在飞」。

反向佐证：`agent_turn_prepare` 在新 turn 开始时立即清 `needsCrossTurnResume`（`index.ts:530-533`，注释明示 *"Without this, sessions.changed keeps firing with needsCrossTurnResume=true → infinite loop"*），驱动条件在 turn 真正启动的那一刻即失效。

⚠️ **该结论的成立条件**：幂等键必须继续从 `totalContinuations` 派生。若将来改成时间戳、随机数或递增序号，此论证立即失效、5.6 重新成为前置。**迁移驱动器到主进程时必须在代码注释里锚定这一点。**

**结论**：MA 侧 5.10 可与 OMM 引擎侧**并行开工**，无需等待 5.6 落地及重新 vendor。5.6 自身仍应实施（它治的是 P0-6 停滞误报，价值独立）。

---

## 8. 未采纳与理由

| 方案 | 不采纳理由 |
|---|---|
| 自研 durable execution 引擎（Temporal 式事件溯源重放） | host 已有 session store，本地已有 checkpoint；重复造。oh-my-matrix 业界基准文档已评估并接受「仅稳定点 checkpoint」 |
| 独立 LLM 评审员判定完成 | ADR-019 D2 已定边界（判定留在规则层）。§3.1 的 PARC「独立上下文自评」是同类思路，但引入它等于推翻 ADR-019，需另开决策 |
| 推翻渲染进程驱动跨轮 | **v2 已推翻此条**：v1 认为渲染进程驱动是 host 能力边界。**这半句错了**——能力边界要求的是「某个 MA 侧组件派发 `chat.send`」，不是「渲染进程派发」。主进程同样能派发且更适合（可重放 RPC、不受窗口隐藏影响、事件到达更早）。见 5.10 |
| 给 `require_approval` 补通路 | 策略层从不返回该值（§2.5），补通路是给死分支写代码 |
| 把「加人工确认」当**唯一**安全兜底 | LITL / HITL Dialog Forging 表明审批对话本身可被伪造（§3.1），故确认框不能是唯一防线。权限收敛须靠 allowlist / 隔离等结构性手段 |
| 收紧 `trustWorkspace` 为默认 false | MA 的 POLICY OVERRIDE 是明确的产品决策（`init-default-plugins.ts:686-691`），且关掉它会连带禁用自动验证命令 → 反而加重 P0-4 |
| **修「session-index 跨 run 丢更新竞态」**（审计 3.9） | **驳回**：`updateSessionIndex`（`state-persister.ts:221-240`）全程同步 I/O（`readFileSync`/`writeFileSync`），且在 per-runId Promise 链的 `.then()` 内原子执行——单线程 JS 的同步块不可被其他微任务抢占，故不存在交错窗口。此外 `listResumableCheckpoints`（`:378-423`）直接扫目录、不依赖索引，即使索引真丢也不影响 `register()` 恢复。**注**：真正的索引问题是 P0-2（根目录不一致），与并发无关 |
| **给本模块加模型失败 fallback**（审计 3.12） | **归属错**：autopilot 只经 `before_model_resolve`（`index.ts:792-828`）返回 `{modelOverride}` **建议**，不拥有模型调用，无从感知调用失败。重试/降档属 host 责任。若要推进应向 host 提需求，不在本模块 |
| **给验证期提高 effort**（审计 3.12 的「相位倒挂」） | **前提错**：验证期执行的是 shell 命令而非 LLM 推理，`effort='low'` 是正确选择（`effort-injection.ts:37-44` 注释明示 "fast execution"）。真正的倒挂是修复轮 tier 偏低，已收入 5.13 |
| **恢复 autopilot 运行面板**（v1 §5.11） | **决策：不恢复**（2026-08-01 产品决策 + 对既有删除决策的二次确认）。详见下方专条 |

### 8.1 运行面板：为什么不恢复（v2 新增）

v1 §5.11 提议「把 20+ 暗字段接出来」，依据是「无 autopilot dashboard 页面（grep `src/pages` 无对应路由）」。**该依据不成立**——面板不是缺失，是被显式删除的：

| 项 | 事实 |
|---|---|
| 删除提交 | `347df92a3`，2026-06-10，标题 **「feat(autopilot-ui): Apple HIG ConfigPanel + 移除 Dashboard UI（备份至 `origin/symphony`）」** |
| 删除范围 | `src/pages/AutopilotDashboard/` 12 文件、`/autopilot` 路由、`autopilot-dashboard` i18n 命名空间（en/zh）、ChatHistory/ChatToolbar Badge、ChatInput 看板入口、约 20 个测试文件。计 **4535 行删除** |
| 连带改动 | 同一提交把 `ContinuousModeToggle` 改为「无 projection 时返回 null（看板入口已移除）」——这正是 P0-4 L2 里 `handleToggle`（`ContinuousModeToggle.tsx:62-65`）不可达的成因 |
| 备份 | `origin/symphony`。故砍掉本提案**零信息损失**，将来要恢复可直接取回 |

**v1 那份「参考草案」也已作废**：`.omc/plans/ralplan-autopilot-dashboard-apple-ui.md`（2026-06-08）改的正是上述被删的 8 个文件，比删除提交早两天。它是被该删除作废的旧计划，**不是可参考的设计输入**，v1 §5.11 对它的引用是错引，已删除。

**2026-08-01 产品决策**：MA 侧 autopilot 定位为**后台逻辑 + 异常提醒**，不新增 UI 界面。故本条从「未做的方案」转为「已决策不做」。

**放弃了什么（据实记录）**：`AutopilotProjection` 共 34 字段（`resources/claw-plugin/autopilot/dist/src/projection.d.ts:2-44`），渲染侧实测消费 8 个（`status`/`enabled`/`canStop`/`lastGoal`/`pauseReason`/`blockedReason`/`totalContinuations`/`maxTotalContinuations`，另 `needsCrossTurnResume` 仅 store 内部用）。其余 26 个继续无消费点，其中长跑相关的：

```
lastActivityAt · startedAt · runtimeMs           ← 「它还活着吗」，部分由 5.14 托盘覆盖
evidenceStatus · evidenceSummary · lastEvidenceCommands · completionUnverified  ← 「验证过了吗」
estimatedCostUsd · tokenBudget · inputTokensUsed · outputTokensUsed             ← 「烧了多少钱」
retryCount · nextRetryAt · lastToolError · degraded · orchestrationState        ← 「在退避还是死了」
```

覆盖策略：**异常时推提醒**（5.10 驱动器照 `todo-executor.ts:485` 形状）覆盖被动感知；**托盘 tooltip**（5.14）覆盖主动查询存活。成本与 evidence 状态**确实不再可见**，这是本决策的已知代价，非疏漏。

---

## 9. 不推翻的既有决策

本设计与下列既有决策**兼容**，逐条说明：

| 决策 | 本设计的关系 |
|---|---|
| **ADR-008**（worktree 管理委托 host） | 5.9 删的是从未生效的配置项，正是对该 ADR 的**落实**。5.1 把 checkpoint 移出用户工作区同样与之一致——checkpoint 是引擎协调状态，不是 workspace 内容 |
| **ADR-016**（status 唯一写者） | 5.4 第三步**加强**该不变式：收缩 legacy `resume()` setter 的职责，消除 P1-8 的越权写入。新增转移全部走 reducer |
| **ADR-019**（conditional evidence judging 边界） | 5.4/5.7 都在规则层（命令退出码），不引入 LLM 评审；§8 已列明越界方案不采纳 |
| `autopilot-dynamic-workflows-boundary.md`（half-merge 故意设计） | 5.5 只为**观测**目的把 subagent 工具活动归并进父 run 台账，不动 security/lifecycle 轴。P1-13 仍只记录不提议合并权限边界 |
| 三插件 hook priority 11/10/9 | 本设计不触碰 hook 注册顺序 |
| `_resetForTest` 生产禁用 | 5.0 的诊断打点不得引入任何生产可达的状态清空路径 |

---

## 10. 对抗 review 记录

本文经**四轮**独立审查。v1 三轮（事实核查 / 对抗质疑 / 引用核实），v2 一轮（跨报告合并核查）。作者与审稿分属不同上下文，不自我批准。记录在此以便后续读者判断可信度边界。

### 10.1 事实核查（v1，58 条 `file:line` 断言逐条复核）

结果 **55 符合 / 3 失配 / 0 无法验证**，三条失配已全部处置：

| 失配 | 原稿 | 实际 | 处置 |
|---|---|---|---|
| 测试规模 | 「805 个测试、55 文件」（grep 估算） | 审稿实跑 `npx vitest run`：**58 文件 / 861 例（857 passed + 4 跨平台 skip）**，全绿；作者已复跑确认 | 已更正 §1、§4「测试真实性」，并在 §6 补回归基线 |
| `onSend()` 行号 | `ChatInput.tsx:860` | `:860` 是 abort 判断分支；`onSend()` 在 **`:941`** | 已更正 §2.6 调用链 |
| `degraded` 渲染位置 | 列在 `ContinuousModeToggle` 的渲染字段里 | toggle **不消费**该字段；实际用在 `EmployeeSessionTree.tsx:211` / `ChatHistory.tsx:119`（仅 `aria-label`）。⚠️ 审稿据此判为「暗字段」，**作者复核后不采纳该结论**——它确有渲染消费点，只是不在 toggle | 已改为分组说明（§4 P1-12） |

### 10.2 对抗质疑（v1，假设每个缺口都是错的，逐个证伪）

裁决：**B/C/D/E/F/H 存活；A 存活但触发条件被更正；G 由 P2 降为 P3**。三个阻断项已修：

1. **缺口 A 的触发路径原本错了** — 原稿把 `ContinuousModeToggle` 的「漏传 `workspacePath`」当 P0 触发，审稿证明该分支**不可达**（有投影才渲染 ⊕ 只在 idle 才执行，两者互斥）。真实触发是「ChatInput + 用户未配置 workspace」。已改写（现 §4 P0-4 与 §5.12）；
2. **§5.2 原方案自相矛盾** — 「所有 `skipped` → pause」会让文档/分析类任务永远无法无人值守完成，与 §1 目标冲突，且打断 4 个现存测试（审稿给出具体行号，作者已逐条复核确认）。已按**成因**收窄（现 §5.4 第一步）；
3. **§5.8 双驱动缺乏幂等证据** — 审稿指出「两侧同键」不足以证明安全，要求 gateway 真实去重的证据。作者已查证并补入（现 §5.10）。

另采纳两项补充：新增缺口 I（`hasNoActionableTask` 绕过早停守卫，现 §4 P2-16）、§5.2 补齐**四处枚举同步**清单与 TENSION 3 交互警告。

### 10.3 引用核实（v1，§3 外部结论逐条回溯一手来源）

结果：核心观点全部有实质来源支撑，**无虚构论文**；但 6 处标注/措辞需修，已全改：

- 章节号错误 2 处：arXiv 2508.03501 的 `R(τ)` 定义在 **§3.1**（非 §2.1）、"encourages" 段在 **§6**（非 §5）；
- 符号错误 1 处：SWE-TRACE 的执行奖励是 **`r_exec`**（非 `r_exe`）；
- 来源错误 1 处：LITL **不是 OWASP 条目**，是 Checkmarx Zero 研究（且日期应为 **2025-12**，非 2025-09/10）；
- 措辞越界 2 处：删除未经确认的「ICLR 2026 **poster**」格式标注；`Tmax` 从「独立终止机制」弱化为「训练时回合上界」（论文未明文支持强表述）。

### 10.4 v1 的方法论缺陷（v2 自评）

v1 全部结论来自**静态源码阅读**。这让它错失了三类问题，且这三类恰恰是最严重的：

| 缺陷类型 | v1 为何看不见 | v2 用什么方法发现 |
|---|---|---|
| 跨进程契约不匹配（P0-1b：空消息被拒） | 渲染进程、Electron 主进程、gateway 三侧代码分属三个仓/构建产物，静态阅读任一侧都自洽 | 逐跳追踪同一次调用穿过三个边界 |
| 路径构造不对称（P0-2：写 workspace 根、读 cwd） | 写路径与读路径相距 300 行，各自看都正确 | 读磁盘上真实 checkpoint 的**位置**，与恢复代码扫的位置对比 |
| 「功能从未工作」（P0-1） | 861 个测试全绿，代码逻辑自洽 | 读生产日志与真实 run 状态，发现零成功记录 |
| **「缺失」误判为「缺口」**（§5.11 面板，v2 后期发现） | 只 grep 当前工作树。`git log` 从未被用作证据源 | `git log -S` / `--diff-filter=D` 查历史，发现是 2026-06-10 的显式删除决策 |

**教训（已写入 §6 测试策略）**：`file:line` 级的静态准确性（v1 做到了 55/58）与「功能是否真的工作」是两个独立维度。前者不蕴含后者。

**教训二：「grep 不到」≠「不存在过」。** 缺失有两种成因——**从未存在**（缺口，该修）与**曾存在被删**（决策，动它就是翻烧饼）。这两种在 grep 输出里**完全同形**，只能靠 `git log -S '<符号>'` / `git log --diff-filter=D --name-only -- '<路径>'` 区分。v1 §5.11 因缺这一步，把 4535 行的删除决策当成了待补的缺口——**这是本文范围最大的一处误判**。

据此把文档全部「不存在 / 从未 / 无消费点」类断言复核了一遍：

| 断言 | 复核结论 |
|---|---|
| 无 autopilot dashboard 页面（§4 P1-12） | ❌ **错，是决策**——`347df92a3` 删除，见 §8.1 |
| 参考草案 `ralplan-autopilot-dashboard-apple-ui.md`（v1 §5.11） | ❌ **错引**——改的正是被删的 8 个文件，比删除早两天，已作废 |
| `blockedReason: 'stalled'` 无生产写点（P1-8 / 审计 3.7） | ✅ 成立——`87c5cd3` 中那两处是测试 fixture，非生产写点 |
| `evidence_missing` 无生产写点（P1-8） | ✅ 成立——全历史仅出现在集合定义 |
| `workspace_failed` / `permission_denied` 事件从未派发 | ✅ 成立——全历史只有定义无 dispatch |
| `workflow.workspace.root` 从未生效（5.9） | ⚠️ **断言对、措辞险**——`workflow-config.ts:165` 注释自承不消费；但同名的 `state.workspace.root`（`index.ts:208`）是 P0-2 核心。§7 迁移表已加显式区分 |

**「插件 INFO 为何不可见」——同一问题连错两次的记录**

这条值得单独记，因为它是本文**唯一被连续两版写错**的机制，且两次都是「读了一半代码就下结论」：

| 版本 | 断言 | 错在哪 |
|---|---|---|
| v1 | 「INFO 被日志级别丢弃」 | 方向对（确实是级别过滤），但没说清是**哪一级、在哪一跳**被丢，等于没有可操作信息 |
| v2 初稿 | 「stdout 只被排空、从不落盘，故 info 静默丢弃」 | **事实错误**。只读了 `manager.ts:2164` 那句 `CRITICAL: Consume stdout` 注释就收工，没往下读两行——`:2166-2181` 明确逐行分类并落盘，且支持 info 档 |
| v2 定稿 | `classifyStdoutMessage` 兜底降级为 `debug`（`manager.ts:678`），再被 INFO 默认级别过滤 | 三跳全部读通 + 用 5 月/6 月日志的零重叠交叉验证 |

**教训三**：注释描述的是**意图**，不是**全部行为**。`CRITICAL: Consume stdout to prevent buffer blocking` 说的是「必须排空」，不是「只排空」。

这三条教训同源：**只看一个证据面就下结论**。分别是「只看测试不看生产」「只看工作树不看历史」「只看注释不看实现」。

### 10.5 v2 合并核查（2026-08-01）

**方法**：先起一个 14-agent 验证 workflow 对审计 3.1–3.12 逐条取证，因网络故障（`ENOTFOUND`）**全部 14 个 agent 失败、零产出**。改为作者本人逐条核实 + 4 个定向 agent 复核。**4 个 agent 的结论中有 3 处经作者复核被驳回**——记录于下，因为它们说明了「agent 报告不可直接采信」：

| # | agent 结论 | 作者复核 | 处置 |
|---|---|---|---|
| 1 | 「插件被双重注册，第二次注册清空内存 map，导致 hook 找不到 run」 | **驳回**：那些 map 是模块级 `let`（`index.ts:82-85`），清空对 stall 巡检同样可见，而巡检明确仍认得该 run；且清空块在 `_resetForTest` 内，生产会 throw（`:183-185`）。该 agent 是**排除法**得出结论，其自身机制自相矛盾 | §2.7 记为已排除假设 |
| 2 | 「`RESUMABLE_BLOCKED_REASONS` 里 `evidence_missing` 可达」（隐含于其可达性表） | **驳回**：穷举全部 pause/blocked 写点后确认四个成员**全不可达**（§4 P1-8）。该 agent 的表自身前后矛盾 | 升格为独立缺口 P1-8，并据此修正 §5.4 |
| 3 | 「验证期 effort 强制 low 是相位倒挂」（承袭审计 3.12） | **驳回**：验证期执行 shell 命令而非 LLM 推理，low 正确（`effort-injection.ts:37-44` 注释明示）。只保留「修复轮 tier 偏低」半条 | 移入 §8 未采纳，正确的半条进 §5.13 |

**12 条跨报告矛盾裁决**（详见 §4 各条与 §8）：

| # | 争点 | 裁决 |
|---|---|---|
| 1 | stall 失效方向 | **两者都对，互补**——活动刷新有派发/完成两点，故既误报长工具又漏报空转（§2.7 L2 + P0-6） |
| 2 | retry 能否派发第二个 turn | **审计的后果错，v1 对**——`enqueueNextTurnInjection` 结构上无法启动 turn；真实后果是 run 卡死（P0-7） |
| 3 | blocked 能否 resume | **两者都错**——resume 绕过守门，几乎全部 blocked 都能 resume 但一轮后复死（P1-8） |
| 4 | `'stalled'` 是死条目 | **审计对**（P1-8 表） |
| 5 | turn 计数回退 | **v1 对（P3）**，但 v2 补充其保护是搭便车的（P3-20） |
| 6 | 验证期 effort low | **审计措辞错**（§8） |
| 7 | 模型失败无 fallback | **归属错，归 host**（§8） |
| 8 | session-index 跨 run 竞态 | **驳回**——同步 I/O 不可抢占，且恢复不依赖索引（§8） |
| 9 | `isRunStuck` 致双 run 并存 | **后果驳回，触发条件成立**——真实代价是 checkpoint 泄漏（P2-17） |
| 10 | `released` 停滞盲区 | **盲区真，暴露面小**——真实风险是 validation 期 TOCTOU（P1-14） |
| 11 | maxBuffer 冤杀 | **审计对**，v2 补充溢出与真实失败同形（P1-10） |
| 12 | goal/progress 截断 500 | **审计夸大**——500 只在 `setGoal()` 生效；但恢复优先级不对称为真（P1-11） |

**6 条新发现**（两份报告均无）：P0-1b（跨轮空消息被拒，机制级根因）、P0-1（无成功多轮 run 证据）、P0-2（checkpoint 根不一致）、P1-8（resume 绕过守门 ⊕ 可恢复集不可达）、P1-9（degraded 丢增量）、P2-19（sessionKey 双源）。

### 10.6 本文的已知边界

- §3 的外部结论多来自**单个 benchmark 或单个系统**，不代表业界普遍实践——本文按此口径行文，未外推。合并进来的工程实践来源按三档标注证据等级（§3.2），二手转述的事故金额未采信；
- **P0-1 的机制虽已定位到 P0-1b，但不保证充分**：`totalTokensUsed: 0` 提示 `llm_output` hook 可能也未匹配到 run，这部分**未证**。§5.0 的诊断步骤即为收口而设；
- **双 turn 并发风险已确证为真**（v2 收口）：gateway 的 `chat.send` 无任何 session 级串行化。两道在飞守卫（结果缓存 `dedupe`、`chatAbortControllers`）均按 `clientRunId`（= `idempotencyKey`）索引；`createChatRunRegistry`（`server-chat-state-B4ta4USz.js`）虽有 `add/peek/shift` 队列形态，但其消费点只在 lifecycle/terminal 事件处按 `evt.runId` 做**事件路由记账**（`server-chat-C9AwM_MK.js` 的 `registry.peek(evt.runId)` / `registry.shift(evt.runId)`），**不是派发前的闸门**——没有任何代码在起 turn 前查询它。故同一 session 的两个不同幂等键会各起一个 turn 并同时写工作区。**注意**：在 P0-1b 修复前该风险不可达（空消息先被拒绝），修复后即成为真实风险。
  ⚠️ **v2.1：`5.6 → 5.10` 的前置关系已解除**（论证见 §7「实施顺序」）。该结论原建立在**双驱动**前提上；5.10 翻转为主进程单驱动后，实测 `incrementTotal` 的四个写点（`index.ts:438/553/567/1039`）全在 turn 完成路径，reducer 的 `stall_timeout`（`orchestrator.ts:205`）/`retry_due`（`:230`）分支均不改 `totalContinuations` → stall 误报时幂等键不变 → 被 gateway 去重。**成立条件**：幂等键须继续从 `totalContinuations` 派生；
- **MA 侧可观测性收缩是产品决策，非疏漏**（v2.1，2026-08-01）：autopilot 在 MA 侧定位为后台逻辑 + 异常提醒，不新增 UI。故 `AutopilotProjection` 34 字段中 26 个继续无渲染消费点——成本（`estimatedCostUsd`/`tokenBudget`）与验证状态（`evidenceStatus`/`completionUnverified`）**确实不可见**，仅存活指示经 5.14 托盘 tooltip 部分覆盖。完整清单与决策依据见 §8.1。**这不是本文的分析盲区，而是已知代价**；
- **P0-1b 之后是否还有其他阻塞点未知**：本文只证明了空消息必被拒这一条。修复它之后 loop 能否真正连续转动，需实测验证（§5.0）；
- P1-13（子 agent 扇出不透明）是既有文档自评的已知项，本文只记录其对长程 loop 控制的影响并在 §5.5 顺带覆盖观测面，未提议改动 half-merge 的权限边界；
- P2-16（`hasNoActionableTask`）只给了缓解方向，未纳入 §5 方案——需另行评估模式精度后再定；
- §2.7 的日志分析基于本机单用户数据（2026-05-28 起）。样本中只有一个真实 run checkpoint，**样本量小**是本文最大的证据弱点；结论已按此收敛措辞（「无成功多轮 run 的证据」而非「autopilot 不可用」）；
- 审计的原始范围声明仍适用：其 index.ts 只做了 4 个定点验证，未逐行审；未做定量性能基准；oh-my-claudecode 侧部分文件未读；
- 所有方案均**未实施**，实施时须补 oh-my-matrix ADR-021（编号待定，见 §7；ADR-020 已被 reducer sole-writer 占用）。
