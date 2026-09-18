# 长程任务自主执行子系统盘点（oh-my-matrix）

> 状态：Analysis · 2026-09-18
> 基线：`master` @ `f58f8ef03cd111f8eb4701158b19b796227b3be7`（工作区 clean）
> 方法：知识图谱（project `Users-guanxueliang-Desktop-Matrix-DynamicWorkflow-oh-my-matrix`，index 时间 2026-09-09T15:02:41Z，generation 与 HEAD 一致）+ 源码直读 + grep 交叉验证。全部被引用文件已过 `check_index_coverage`，均为 `no_recorded_issue` / `metadata_match`（该信号是 best-effort，不构成完整性证明）。
> 实测基线：`cd packages/autopilot && npx vitest run` → **Test Files 72 passed (72) / Tests 1022 passed | 4 skipped (1026)**，exit 0。
> 术语：沿用 [CONTEXT.md](../../CONTEXT.md) 的 Autopilot / Dynamic Workflows / Permission Policy / Instinct / Runtime Guard / Host Deploy。结构分析部分沿用 codebase-design 词汇（module / interface / depth / seam / adapter / leverage / locality）。

---

## 0. 盘点范围的实际边界（先纠正一个前提）

盘点任务点名的方向里有一半在本仓**不存在**，必须先说清，否则后面的"有/没有"会被误读。

| 名字 | 本仓状态 | 证据 |
|---|---|---|
| `autopilot` | **活跃源码** | `packages/autopilot/`（`index.ts` 2008 行 + `src/` 23 文件），package `@oh-my-matrix/autopilot` |
| `pipeline` | **概念存在，非独立 module** | 指 Dynamic Workflows 的 `.prose` 编排模式之一，不是长程执行子系统的独立部件 |
| `team` | **已删除**（v0.x 实现移除） | [CONTEXT.md:14](../../CONTEXT.md)；[ADR-008](../adr/008-delegation-to-host.md) 记载删除范围 |
| `ralph` | **已删除并显式委托** | [ADR-008:31](../adr/008-delegation-to-host.md)「Delete omm's `ralph`, `autopilot`, and planned `goal` capabilities」；当前 20 个 tracked 文件提到 ralph，全部是 `docs/`（ADR / archive / analysis / audits），**零源码** |
| `ultragoal` | **不存在** | 全仓 tracked 文件仅 1 处命中：`docs/archive/adr/007-goal-mode.md`（已归档设计） |
| `ultrawork` | **不存在** | 4 处命中全为 `docs/`（CHANGELOG / ADR-008 / analysis / audits），零源码 |
| `swarm` | **不存在** | 2 处命中均为 `docs/analysis/` 的业界对照文档 |
| `cancel` | **已删除**（`omm_cancel` tool 移除） | [ADR-008:39](../adr/008-delegation-to-host.md) v0.5.0 update |
| `.omc/state` 状态机 | **不属于本仓** | `.omc/` 在 [.gitignore:5](../../.gitignore) 内、未 tracked；磁盘上的 `.omc/` 是 OMC 宿主运行时产物。`.omc/handoffs/` **磁盘上不存在**（`find -type d -name handoffs` 零命中） |
| hooks | **活跃**，但是 **host plugin hooks**，不是 OMC 的 Stop-hook | `packages/autopilot/index.ts` 注册 12 个 host hook；`packages/dynamic-workflows/index.ts:164` 注册 `before_tool_call` priority 11 |
| verification / verifier | **活跃**（evidence gate） | `packages/autopilot/src/evidence-gate.ts` + `command-runner.ts` |

> ⚠️ `ralph` / `ultragoal` / `ultrawork` / `swarm` / `cancel` 是 **oh-my-claudecode（OMC）** 的 skill 名。本仓（oh-my-matrix）与 OMC 是两个不同项目：OMC 出现在本仓仅作为**参考实现**被对照（见 `docs/core/autopilot/long-horizon-autonomy.md` §3.4）。**本文不把 OMC 的能力缺失记为本仓的 gap。**

**因此本文的真实盘点对象是**：Autopilot（长程执行引擎）+ Dynamic Workflows 的 Runtime Guard（委派边界）+ Permission Policy（共享决策内核）+ Instinct（跨会话记忆）。

**已定 ADR，不重提为 gap**：ADR-008（autonomous-loop 委托 host / ralph·goal 删除）、ADR-016（`status` 派生 + reducer 唯一写者）、ADR-019（evidence 判定留在规则层，不引入独立 LLM 评审员）、ADR-020（reducer 唯一写者扩展到 coupled aux 字段）、ADR-014（autopilot 不做 subagent 安全 guard）、ADR-015（`dist/` 不提交）。

---

## 1. 六维度现状表

强度评级口径：**强** = 机制完整 + 有测试 + 单一写入者；**中** = 机制存在但有已知缺口或依赖外部消费方；**弱** = 机制存在但不生效 / 不可达 / 无消费点；**缺失** = 代码里没有。

### 维度 1 — 任务状态持久化

| 现有机制 | `file:line` | 强度 |
|---|---|---|
| 状态存在**固定用户级根** `~/.matrix/.autopilot/checkpoints/{runId}.json`，与 workspace 解耦（E1/P0-2 修复：原先写 workspace 根、读 `process.cwd()`） | `src/state-persister.ts:82-84`（`getCheckpointRoot`）、`:35`（`CHECKPOINT_SUBDIR`）、`:100-102` | 强 |
| schema 有显式版本 + 迁移：`CHECKPOINT_SCHEMA_VERSION = 2`，`migrateCheckpoint` 做 v1→v2，**更高版本拒绝加载**而非误解 | `src/state-persister.ts:47`、`:316-357`、`:318-322` | 强 |
| 持久化 schema 是 `AutopilotState` 的**显式子集**（不存 `permissionAudit`、不存 `status`） | `src/state-persister.ts:114-149`（`AutopilotCheckpoint`） | 强 |
| 落盘时**不信任** `status`：`loadCheckpoint` 重算 `deriveStatus`（ADR-016） | `src/state-persister.ts:32`（import `deriveStatus`）、`:442`（`degraded: true` 标记恢复 run） | 强 |
| 唯一写入者：`setState` → `persistAfterTransition` → `saveCheckpoint`，全仓只有这一条生产落盘链；原子 tmp+rename + per-runId Promise 锁 | `index.ts:533-541`（`setState`）、`:401-414`（`persistAfterTransition`）、`src/state-persister.ts:234`（`atomicWriteFileSync`）、`:227`（`writeLocks`） | 强 |
| 终止态**先删后写**：`done` / `blocked+user_stopped` 删 checkpoint + 清 session index | `index.ts:404-410` | 强 |
| 跨 session 存活：durable `session-index.json` 把 `sessionKey → runId` 落盘，供重启后反查 | `src/state-persister.ts:36`、`:104-106`、`:278`（`updateSessionIndex`）、`:500`（`lookupRunIdBySessionKey`） | 强 |
| legacy 位置迁移：`migrateLegacyCheckpoints([process.cwd()])` 在 `register()` 时把旧位置搬进固定根 | `index.ts:665`、`src/state-persister.ts:590` | 中（只扫 `process.cwd()` 一个候选根；配过非 cwd workspace 的旧 checkpoint 仍漏迁，见 §3 空白 G1） |
| checkpoint 写失败可观测（非纯 fail-silent）：`_writeFailureCount` 计数 + getter | `src/state-persister.ts:49-51` | 中（有 getter，但未见 projection 透出，见 §3 空白 G2） |

### 维度 2 — 中断恢复

| 现有机制 | `file:line` | 强度 |
|---|---|---|
| **进程崩溃/重启**：`register()` 时 `listResumableCheckpoints` → 逐个 `loadCheckpoint` → 回填 `stateByRun` / `sessionKeyToRunId` | `index.ts:665-692` | 强 |
| **会话重连**（run 不在内存）：`session_start` 经 `lookupRunIdBySessionKey` 反查并恢复 | `index.ts:1240-1258` | 强 |
| **session_end 前抢救**：非终止 run 在删内存前强制 `saveCheckpoint` | `index.ts:1274-1279` | 强 |
| **stale-run 守卫**：checkpoint 记录的 `workspacePath` 已不存在 → 拒绝恢复，而非复活到消失的工作区 | `src/state-persister.ts:400-407` | 强 |
| **compaction**：`before_compaction` 存 goal 快照，`after_compaction` 恢复；ledger 存活于 `AutopilotState`（compaction 只压模型对话，不动 state），下一次 `agent_turn_prepare` 重注入 `summarizeLedger` | `index.ts:947-955`、`:957-971`、`:1025` | 强 |
| **用户中断**：`autopilot.stop` RPC → reducer `stop_requested` → `blocked+user_stopped` → `deriveStatus` 得 `idle` | `index.ts:1793-1814`、`src/orchestrator.ts:334`、`:60` | 强 |
| **paused 之后续跑**：两条 RPC。`autopilot.resume`（旧）+ `autopilot.resume_run`（E13 新增，显式续行，防双花） | `index.ts:1664`、`:1740` | 中 |
| resume 守门在 reducer 内**正确**：非 `RESUMABLE_BLOCKED_REASONS` 成员 → no-op 返回原 state | `src/orchestrator.ts:416-443`、`:428` | 强 |
| **已知失效点（代码自认）**：crash-recovery 恢复的 mid-cross-turn run **不再**自动踢 turn（防 P3-29 双花），改为等 host 显式调 `autopilot.resume_run`；但注释明示 stall 路径仍可能重开第二个 turn——「It is a FALLBACK, not a benign no-op」，完全闭环需 MA driver 消费 RPC（跨仓，OMM 范围外） | `index.ts:673-688`（注释全文） | 中（OMM 侧已交付，消费侧未落地） |
| **已知失效点（代码自认）**：`resolveSessionKey` 双源（`ctx` 与 `event`）未审计——「Leaving as-is until a deeper audit of per-hook sessionKey provenance is done」 | `index.ts:584-596` | 弱 |

### 维度 3 — 完成判定

判定链是**四段**，`complete` 这一决策由 `decideContinuation` 出，但**最终 `done` 由 reducer 的 `evidence_finished` 分支写**。

| 段 | 现有机制 | `file:line` | 强度 |
|---|---|---|---|
| ① 文本信号 | `isTaskComplete` 正则匹配中英完成话术，剥 code block，带否定守卫（`所有任务已完成，但还需…` 不算） | `src/completion-detector.ts:1-40`、`:24`（`zhConditional`）、`:33`（`not all tasks`） | 中（本质仍是匹配模型话术） |
| ② 早停守卫 | `totalContinuations < minTurnsBeforeComplete(state)` 强制 `revise`。阈值按 run 分档：普通 2，可验证+受信任 3（ADR-019 Enhancement C） | `src/continuation-engine.ts:63-68`、`:39-45`、`:22`、`:32` | 强 |
| ②′ 绕过口 | `hasNoActionableTask` 命中即立刻 `complete`，**显式绕过**早停守卫（注释自认 "This BYPASSES MIN_TURNS_BEFORE_COMPLETE on purpose"） | `src/continuation-engine.ts:72-80` | 中（唯一能零轮产出 done 的路径） |
| ③ Evidence Gate（外部 gate） | `evaluateEvidence` 判 required 命令退出码；命令经 `execFile`（非 shell 拼接）执行 | `src/evidence-gate.ts:27-133`、`src/command-runner.ts` | 强 |
| ③′ `skipped` 已区分成因（E4） | `skipReason: 'not_configured'` → `done` + `completionUnverified: true`；`'not_executed'`（配了却没跑成：缺失/超时/被 allowlist 丢弃）→ **`blocked` + `evidence_missing`**（可恢复） | `src/evidence-gate.ts:33-52`、`:105-114`、`src/orchestrator.ts:270-303` | 强 |
| ③″ 中途 gate（E7） | `midrunValidationInterval: 5` — 每 N 轮跑一次 validation 做早期纠偏，不只在 `complete` 跑 | `src/workflow-config.ts:26` | 强 |
| ④ 唯一 done 写入者 | 只有 reducer `evidence_finished` 分支能写 `orchestrationState: 'done'`；`passed` → `completionUnverified: false`，`skipped/not_configured` → `true` | `src/orchestrator.ts:254-304`、`:258-268` | 强 |
| ④′ 前置态守卫 | `evidence_finished` 要求 `orchestrationState === 'released'`，否则 no-op | `src/orchestrator.ts:255` | 强 |
| **AC-NNN 验收标准**（4.2.0） | goal 内嵌结构化 AC（Scenario/Expected/Must-not/**Verification**/Priority），零 schema 变更 | `src/acceptance-criteria.ts:28-135` | **弱** — `Verification` 字段只被渲染进 prompt 文本（`:107`、`:121-134`），**无任何路径把它接进 evidence gate 执行**。全仓 `parseAcceptanceCriteria` / `goalInjectionText` 的消费点只有 prompt 注入（`index.ts:1018`、`src/continuation-engine.ts:127`）与 size 分类（`src/size-classifier.ts:43`）。见 §3 空白 G3 |

### 维度 4 — 循环终止

| 刹车 | 默认值 | `file:line` | 强度 |
|---|---|---|---|
| `maxAttemptsPerTurn` | 5 | `src/types.ts:443` | 强 |
| `maxTotalContinuations` | 50 | `src/types.ts:444` | 强 |
| `toolErrorThreshold` | 3 | `src/types.ts:445` | 强 |
| `maxConcurrentAutopilot` | 5 | `src/types.ts:447` | 强 |
| `stallTimeoutMs` | 300s（per-run 可经 WORKFLOW.md 覆盖） | `src/workflow-config.ts:18` | 强 |
| `maxRetries` + 指数退避 + **jitter** | 3 次 / 300s 封顶 / `DEFAULT_RETRY_JITTER` | `src/workflow-config.ts:17`、`:19-22` | 强 |
| **墙钟上限** `maxDurationMs` | **可选，默认未配** | `src/types.ts:360`、判定 `src/cost.ts:49` | 中（机制强，默认关） |
| **成本上限** `maxCostUsd` | **可选，默认未配** | `src/types.ts:361`、判定 `src/cost.ts:33-39` | 中（同上；且 host 不报 usage 时 tokens 恒 0 → no-op，`cost.ts:31` 自述） |
| `tokenBudget` | **可选，默认未配** | `src/types.ts:358`、判定 `src/continuation-engine.ts:86` | 中 |
| 硬上限主判定落在 **60s patrol**（唯一能 turn 内介入的位置），finalize 内为辅助快速路径 | `index.ts:1866`（`setInterval` 60_000）、`:1880`（`detectCapExceeded`）、`src/continuation-engine.ts:96-99` | 强 |
| **受控收尾**：producing run 先注入一次 winddown 让它收尾汇报，下一 tick 才终止 | `index.ts:1884-1888`（`injectWinddown` + `hardStopWinddownArmed`） | 强 |
| **`hard_stop_requested` 绕过 TENSION 3**：`pause_requested` 在 `retry_queued` 下是 no-op（故意），硬上限走独立事件，否则上限在整个 retry 窗口内失效 | `src/orchestrator.ts:400`、`:369`、`index.ts:1889-1895` | 强 |
| **停滞检测双向修（E6）**：方向一 在飞守卫——`inFlightToolStartedAt` 非空时用 `INFLIGHT_TOOL_CAP_MS`（30min）而非 300s，长工具不误报 | `index.ts:1915-1917`、`:288`（注释）、`src/stall-detector.ts:26-49` | 强 |
| 方向二 生产力检测——`totalContinuations - lastProgressTurn(ledger) >= noProgressTurns(3)` → `pause('no_progress')`，输入是 exec-class 过滤后的 ledger 活动（只读调用不记账） | `index.ts:1954-1965`、`src/workflow-config.ts:25`、`src/progress-ledger.ts:201-210` | 强 |
| **evidence-coupled 记账（F6/4.4.0）**：churn 不通过验证**不算** progress；`skipped+not_executed` 也不算 | `src/progress-ledger.ts:43-51`（`countsAsProgress`） | 强 |
| `stop_requested` 信号生效路径：`autopilot.stop` RPC → reducer → `blocked+user_stopped` → `persistAfterTransition` 删 checkpoint（不可被重启复活） | `index.ts:1801-1805`、`index.ts:404-410` | 强 |
| 孤儿清扫 | 24h | `index.ts`（`ORPHAN_THRESHOLD_MS`，patrol 内 `:1983-1986`） | 强 |
| 终止态全部落 `enabled: false`，防 zombie turn | `src/orchestrator.ts:262`、`:285`、`:296` | 强 |

> 注：`stop_requested` 是 orchestrator **事件名**；本仓源码里**没有** `stop_requested` 这个布尔状态字段（grep `stop_requested` 的 15 个 tracked 文件命中中，源码侧全部是事件 type 字面量）。任务描述里的「`stop_requested` 这类信号怎么生效」在本仓对应的是「事件 → reducer → 终止态 → 删 checkpoint」这条链。

### 维度 5 — context 管理

| 现有机制 | `file:line` | 强度 |
|---|---|---|
| **compaction 处理**：goal 快照保存/恢复双 hook | `index.ts:947-955`、`:957-971` | 强 |
| **结构化台账替代计数串（E5）**：`Ledger` = `folded` 聚合 + 最近 6 轮 detail；JSON（非 prose，"a structured artifact the model is less inclined to rewrite"） | `src/progress-ledger.ts:70-84`、`:87`（`LEDGER_MAX_DETAIL = 6`）、`:171-189`（`summarizeLedger`） | 强 |
| **替换而非叠加**（对齐 Ghost Context）：fold 是 merge 进聚合并去重，不拼接历史摘要串 | `src/progress-ledger.ts:53-58`（注释「替换而非叠加」）、`:132-149`（`foldOldest`） | 强 |
| **容量硬界**：per-entry 8 files / 4 cmds，summary 12 files / 8 cmds，item 120 字符 | `src/progress-ledger.ts:88-92` | 强 |
| **注入侧也有界**：retry instruction 上限 2000，ledger JSON 单独截到 700，且截断**保留收尾行** | `src/continuation-engine.ts:115`、`:136`、`:240-254`（`truncatePreservingClosing`） | 强 |
| **RPC-safe 分离**：`state.progress` 存人类可读 headline（`autopilot.status` 会原样返回，不能塞 JSON），详细 JSON 只走 agent-facing 注入 | `src/progress-ledger.ts:235-252`（`buildProgressHeadline`）、`index.ts:1314` | 强 |
| **失败信号回注**（抗压缩遗忘）：上轮 evidence failed 的 stderr 摘要注入下轮指令 | `src/continuation-engine.ts:152-155`、`:186-216` | 强 |
| **handoff 产物** | — | **缺失**：`.omc/handoffs/` 在本仓磁盘上不存在，源码零引用。跨 turn 交接靠 checkpoint + ledger 注入，不靠 handoff 文件 |
| **subagent 隔离** | `packages/dynamic-workflows/index.ts:164-215`（`before_tool_call` priority 11，`:58` `:subagent:` 判定，`:177-200` fail-closed + `defaultDeny: true`） | 强 |
| **跨会话记忆（Instinct）**：`after_tool_call` 脱敏摘要 → `.instinct/observations.jsonl`（轮转 + secret-scrubbed）；`session_start` 召回 | `packages/instinct/`（package 存在，`dist` 未 tracked 按 ADR-015） | 中（v0.1.0，只交付记忆基质+召回，蒸馏未做——CONTEXT.md:58 明述） |

### 维度 6 — 委派

| 现有机制 | `file:line` | 强度 |
|---|---|---|
| **host delegation 是根决策**：引擎**不轮询、不自发驱动**，完全由 host hook 事件驱动 + 60s patrol。12 个 host hook 注册点 | `index.ts:705`（`before_agent_finalize`）、`:899`（`after_tool_call`）、`:947`/`:957`（compaction）、`:972`（`agent_turn_prepare`）、`:1055`（`before_model_resolve`）、`:1094`（`before_agent_run`）、`:1113`（`before_tool_call`）、`:1193`（`llm_output`）、`:1235`/`:1261`（session）、`:1288`（`agent_end`） | 强 |
| **hook 注册 adapter**：`api.on` 优先、`api.registerHook` 兜底、两者都缺则显式禁用插件（不静默半死） | `index.ts:699-703` | 强 |
| **7 个 RPC 面**：`activate` / `resume` / `resume_run` / `stop` / `status` / `setGoal` / `cleanup` | `index.ts:1493`、`:1664`、`:1740`、`:1793`、`:1816`、`:1834`、`:1850` | 强 |
| **subagent 半合并边界（故意设计）**：资源轴归父（token 归并防大扇出绕过 `tokenBudget`）；安全/生命周期轴归 DW，autopilot 不接管（ADR-014） | `docs/design/autopilot-dynamic-workflows-boundary.md:101-102`；`index.ts:576-582`（`findRunBySessionOrParent`）、`:1061`（`before_model_resolve`）、`:1200`（`llm_output`） | 强（设计明确） |
| **canary 自愈**：`before_agent_finalize` 从未触发（hook 被禁/降级）→ `agent_end` 走 fallback 跨轮注入或在上限处 pause | `index.ts:1288`、`canaryFired` 置位点唯一 | 强 |
| **priority 链协调**：DW guard 11 > autopilot 10 > audit 9，block 短路低优先级 | `packages/dynamic-workflows/index.ts:4-7`、`:42-45`、`:162`、`index.ts:1113` | 强 |
| **event shape 编译期契约**：防宿主改字段后 fail-open | `src/event-shape.contract.ts`、`packages/dynamic-workflows/src/event-shape.contract.ts` | 强 |
| **Host Deploy 边界**：仓库测试通过 ≠ 线上生效，必须 publish + host 版本 bump + gateway 重启 + deployed-dist smoke | `CONTEXT.md:66`、`AGENTS.md:57-58` | 强（文档层），见 §3 空白 G4（smoke 脚本当前不可用） |

---

## 2. 结构性问题（codebase-design 词汇 + deletion test）

### 2.1 shallow module 候选

#### S1 — `RESUMABLE_BLOCKED_LOCAL` 镜像：shallow 且理由已失效

`src/state-persister.ts:652-665` 手抄了一份 `RESUMABLE_BLOCKED_REASONS`，注释给的理由是：

> "Mirror of RESUMABLE_BLOCKED_REASONS from orchestrator.ts (kept local to avoid a circular import: orchestrator.ts imports nothing from this module...)"

**该理由不成立**：`src/state-persister.ts:32` 已经 `import { deriveStatus } from './orchestrator'`，而 `src/orchestrator.ts:8-16` 的 import 列表里没有 state-persister。依赖方向本来就是单向的，**不存在环**。

这个 module 的 interface 复杂度（一个 `isResumableBlockedReason` 谓词 + 一份必须手工同步的集合 + 一个专门守护同步的 parity 测试 `tests/state-persister.test.ts:299-312`）≈ 实现复杂度（一次 `Set.has`）。它是 shallow 的。

**deletion test 结论：复杂度收敛。** 删掉 `RESUMABLE_BLOCKED_LOCAL` + `isResumableBlockedReason`，把 `src/state-persister.ts:548` 的调用改为直接 `RESUMABLE_BLOCKED_REASONS.has(cp.blockedReason)`（import 已在），则同时删掉：① 手工同步义务、② parity 测试、③ 一类漂移 bug。

**该 bug 已发生过一次**：E6 新增 `no_progress` 时漏同步这份镜像，由 PR #147「RESUMABLE mirror 奇偶修复（E6 漏同步 no_progress）」补救（`docs/core/autopilot/omm-implementation-status.md:22`）。漂移的代价是真实的：镜像判错会让 `no_progress` 暂停的 run 被判为终止态，24h TTL 后 checkpoint 被扫掉、状态丢失（parity 测试自己写明了这个后果）。这不是"重复本身不好"的洁癖论证，是一个有前科的 seam。

#### S2 — `src/size-classifier.ts`：shallow，但删除只会搬家

61 行、单一纯函数 `classifyTaskSize`，interface（`goal: string | undefined → TaskTier`）比实现（两组信号词 + 两个长度阈值 + AC 计数）**更简单**。这是 deep 的正确方向。

**deletion test 结论：只是搬家，不收敛。** 删掉它，`classifyTaskSize` 的三条规则必须搬进 `model-routing.ts` 或 `effort-injection.ts` 的调用处，那里已经在处理相位判定，会变得更杂。**保留。** 它对 leverage 的贡献是真实的：4.3.0 用它让 trivial 任务前 3 轮走 low effort，省 premium token。

#### S3 — `src/goal-manager.ts`（662 B）：疑似 shallow，未深查

文件体积是全 `src/` 最小。本文**未**对它跑完整 deletion test（未读全文），不在此下结论。标注为待查项而非发现。

### 2.2 泄漏的 seam

#### L1 — `hasMigrationGrace` 是一条**断开的 seam**（最确凿的一处）

`src/progress-ledger.ts:74-83` 的文档写得极明确（大写 MUST）：

> "The host's no_progress detector **MUST** consult `hasMigrationGrace()` and, if true, suppress the pause for one tick, then call `consumeMigrationGrace()` to clear it."

而 `index.ts:1954-1965` 的 no_progress detector **就在本 package 里**，且**没有调用这两个函数中的任何一个**。全仓（排除 `dist/`）`hasMigrationGrace` / `consumeMigrationGrace` 的调用点只有：`tests/progress-ledger.test.ts`、`tests/state-persister.test.ts`。**生产调用点为零。**

这条 seam 的两端都在 `packages/autopilot/`：生产者是 `src/state-persister.ts:357`（`migrateCheckpoint` 设 `progressGrace: true`），消费者本应是 `index.ts` 的 patrol。中间没有任何 host 边界。但文档把消费方称作 "the host's no_progress detector"，`docs/design/autopilot-enhancement-design.md:198` 也把它记为「host patrol 需消费 grace（待接入）」，`omm-implementation-status.md:42` 记为「4.4.0 host 接入前置…必须修 F1/F2 + consume `hasMigrationGrace`」。

**后果（按代码路径推导，未实跑验证）**：升级到 4.4.0 后加载一个 v1 legacy checkpoint，`migrateCheckpoint` 设了 grace flag，但 patrol 不看它 → `lastProgressTurn` 落在迁移后重建不出的历史上（`src/state-persister.ts:330-338` 注释自述 legacy folded 无 `lastValidatedTurn`）→ 第一个 patrol tick 就可能 `pause('no_progress')`。**F3 的"真修复"在 package 侧写好了谓词，但没人调用，所以缺陷未被实际修掉。**

**deletion test 结论：删掉这对谓词 → 复杂度收敛（但缺陷仍在，需另修）。** 两种收敛方向，都比现状好：
- **方向 A（推荐）**：在 `index.ts:1957` 的 `if (threshold > 0 && ...)` 里加 grace 检查 + 消费。seam 闭合在同一 module 内，locality 恢复。
- **方向 B**：删掉 `progressGrace` / `hasMigrationGrace` / `consumeMigrationGrace` 三者 + 4 个测试，改在 `migrateCheckpoint` 里直接把 `folded.lastValidatedTurn` 规范化为一个不会立刻 trip 的值。这样迁移语义收敛在 persister 内部，不需要跨 module 的一次性协议。

现状是最糟的第三态：**谓词存在、有测试、有 CHANGELOG 条目，但不生效**。读代码的人会以为 F3 已修。

#### L2 — patrol 回调里的 stale-snapshot seam：靠手写 `continue` 维持正确性

`index.ts:1874`（`for (const [runId, state] of stateByRun.entries())`）取的 `state` 是**迭代时的快照**。回调体内有四个独立的判定块（硬上限 / stall / no_progress / retry_due），每块都可能 `setState`。一旦某块写了，后续块手上的 `state` 就是 stale 的，再基于它 dispatch 就会**覆写**刚写入的状态。

当前靠两处手写 `continue` 挡住：

- `index.ts:1896-1901`（硬上限后）：注释写明「Without `continue`, the stall + retry_due blocks below re-read the stale per-iteration `state` snapshot (pre-cap) and clobber the just-armed winddown... or resurrect a just-terminated run」
- `index.ts:1938-1944`（stall 后）：注释写明「the no_progress block below re-reads the stale pre-stall `state` snapshot and would overwrite this terminal block with a resumable no_progress pause, re-arm the in-flight marker, and release a second time」

两处注释都**明确描述了 bug 的形态**，说明这是修过的真实缺陷，不是理论顾虑。但防护手段是"记得写 `continue`"——没有类型或结构阻止第五个判定块被加在 `retry_due` 之后而忘记前面的 continue 语义，也没有阻止有人在两个 `continue` 之间插入新块。

这里同时是**审计 refcount 的泄漏面**：每个分支都要手写 `setAuditMode('active')` 来平衡 refcount（`:1892`、`:1934`、`:1962`、`:1994`），`index.ts:1810-1812` 的注释解释了为什么多释放/少释放都是 bug（"Releasing again would over-release the shared refcount"）。同一段循环里既有 stale-state 风险又有 refcount 配平义务。

**deletion test 结论：把「取 state」这一步删掉 → 复杂度收敛。** 具体做法：每个判定块开头改为 `const cur = stateByRun.get(runId); if (!cur) continue;`（重取当前态），而不是共用迭代快照。这样 ① 两处 `continue` 的"clobber guard"职责消失（它们仍可用于跳过后续判定，但不再承担正确性）、② 新增判定块不再需要理解前面每个 `continue` 的语义、③ `index.ts:1053-1063` 的 `agent_end` 分支已经在用"重取当前态"模式（见 `docs/core/autopilot/long-horizon-autonomy.md` §5.8 对该模式的记录），patrol 与之统一。这是删除一个隐式不变式，不是搬家。

#### L3 — `after_tool_call` 一个 handler、两次 run 解析、两套 subagent 规则

`index.ts:899-946` 里：

- `:910` `findRunBySessionOrParent(sessionKey)` —— ledger 记账，**subagent 归父**
- `:921` `findRunBySession(sessionKey)` —— 活动刷新 + 工具错误计数，**subagent 不归父**

两条规则都有理由（ledger 要看见扇出内的产出；错误计数不该让子 agent 的失败熔断父 run），但它们**并列在同一个 handler 的相邻 12 行里**，靠两个名字仅差 `OrParent` 的函数区分。

关键点在于：`docs/design/autopilot-dynamic-workflows-boundary.md` 自称是这个 seam 的**单一真相源**（"把散在代码注释里的模块边界、协调契约、隐性耦合升格为单一真相源"），且明确要求（`:105`）：

> "未来任何"让 autopilot 感知 subagent"的改动（如审计 subagent、evidence gate 感知扇出）必须先明确落在哪条轴，**不得再制造第三种半归并**。"

该文档日期是 2026-07-02，其 hook 对照表（`:92`）只记了 `after_tool_call`（错误计数）→ 不归父。E5 ledger（2026-08，PR #138/#139）新增的**归父观测**路径不在表内。代码注释自己声明了归属（`index.ts:905-907`："observation only, no permission change"），但**权威文档没更新**，所以这条轴目前只存在于代码注释里——正是该文档创立时要消灭的状态。

**deletion test 结论：不删（能力是真实的），但这是 documentation seam 泄漏，不是 code seam 泄漏。** 删掉归父记账会让 ledger 对 subagent 扇出全盲（P1-13 的已知问题恶化），复杂度只是转移到"长扇出期间 no_progress 误报"上。正确处置是把第三条轴（**观测轴：归父，只读，不动权限**）补进边界文档的对照表，使其重新成为单一真相源。

### 2.3 为可测性抽了纯函数，但 bug 藏在调用处（locality 缺失）

这是本仓最一致的模式，也是最大的结构性风险来源。`src/` 下 23 个文件几乎全是纯函数 module，测试因此可以零 mock（1026 例 2.28s 跑完）。但**长程执行的真实 bug 全部位于 `index.ts` 的调用处**，而 `index.ts` 是 2008 行的 host adapter：

| 纯函数（测得好） | 真 bug 在调用处 | 证据 |
|---|---|---|
| `checkStall`（`src/stall-detector.ts:26-49`，纯静默计时器） | 误报/漏报都由**调用处**决定：`effectiveStallMs` 的在飞守卫在 `index.ts:1915-1917`；`lastActivityAt` 的三个刷新点分散在 `before_tool_call` / `after_tool_call` / `llm_output` | `index.ts:1915`、`:899`、`:1113`、`:1193` |
| `lastProgressTurn`（`src/progress-ledger.ts:201`，纯） | grace 抑制的缺失在**调用处** `index.ts:1957`（见 L1） | `index.ts:1954-1965` |
| `detectCapExceeded`（`src/cost.ts:48`，纯） | winddown 的 arm/disarm 时序、`continue` 的 clobber guard 全在**调用处** | `index.ts:1880-1901` |
| `orchestratorReducer`（`src/orchestrator.ts:76`，纯 + ADR-016 强制 `deriveStatus` 覆盖） | stale-snapshot 覆写在**调用处**（见 L2） | `index.ts:1874-1998` |
| `evaluateEvidence`（`src/evidence-gate.ts:27`，纯） | 在飞标记、TOCTOU 窗口在**调用处** `index.ts:813` | `index.ts:813`（注释：mark validation in-flight） |

**结构判断**：纯函数化提供了真实的 leverage（1026 个零 mock 测试、reducer 单一写者不变式），这是对的，**不建议回退**。缺的是**调用处本身的 locality**——`index.ts` 同时承担 hook adapter、状态编排、持久化触发、patrol 调度、RPC facade、审计 refcount 配平六件事。L2 的 stale-snapshot 与 L1 的断开 seam 都是这种拥挤的直接产物。

### 2.4 长程路径上的测试覆盖缺口

| 路径 | 覆盖状态 | 证据 |
|---|---|---|
| reducer / 决策 / ledger / cost / evidence 纯函数 | **强**：72 文件 1026 例全绿，核心零 mock；3 包有 coverage 阈值门禁（autopilot 实测 93.5/85.8/96.3/93.5） | 实测 `npx vitest run`；`omm-implementation-status.md:49` |
| patrol 时序（fake timers） | **有**：`tests/stall-detector-wiring.test.ts`、`tests/retry-wiring.test.ts`、`tests/e2e/stall-progress.e2e.test.ts`、`tests/e2e/hard-caps.e2e.test.ts`、`tests/e2e/resilience.e2e.test.ts` 等 9 个文件用 `advanceTimersByTime` | grep 命中 |
| **patrol 的同 tick 多分支交互**（L2 的 clobber 场景） | **未确认**。两处 `continue` 各有注释描述 bug，但本文未定位到断言"硬上限 + stall 同 tick 命中同一 run 时 winddown 不被覆写"的测试。**不确定**——我查了 9 个 patrol 相关测试文件的文件名与 grep 命中，未逐个读完全部用例 | — |
| **grace 消费**（L1） | **确认缺失**：谓词有单测（`tests/progress-ledger.test.ts:261-284`）与 persister 侧单测（`tests/state-persister.test.ts:667-700`），但**没有测试能发现 patrol 不调用它**——因为没有"patrol 遇到 migrated ledger 不 pause"这个用例 | grep 全仓生产调用点为零 |
| **AC Verification 未接 gate**（G3） | **确认缺失**：无测试断言 AC 的 `Verification` 字段会被执行，因为该能力不存在 | `src/acceptance-criteria.ts:107` 只做字符串拼接 |
| 跨仓契约（RPC 消费侧） | **缺失，且已知**：`autopilot.resume_run` 的 OMM 侧有实现，消费侧在 MA 仓 | `index.ts:673-688`、`omm-implementation-status.md:64-68` |
| deployed-dist smoke | **当前不可用**：脚本仅存在于 MA 悬空 commit `ddb6246e`，未合入任何分支 | `omm-implementation-status.md:50`（2026-08-18 核实修正）；issue #171 跟进 |

**难测的 interface**：`index.ts` 的 patrol 是一个 2008 行文件内的 132 行 `setInterval` 回调，闭包捕获 `stateByRun` / `config` / `hardStopWinddownArmed` 等模块级可变状态。它没有可独立调用的 interface——要测同 tick 多分支交互，必须经 `register()` + fake timers + mock host api 驱动整条链。这是"纯函数好测、调用处难测"的具体形态。

---

## 3. 明确的空白清单

只列**确认**存在的空白。写"不确定"的地方就是我确实没查到底。

### G1 — legacy checkpoint 迁移只扫一个候选根（确认）

`index.ts:665` 传 `[process.cwd()]`。而 E1 之前的写路径根是 `state.workspace?.root ?? process.cwd()`。**配过非 cwd workspace 的旧 checkpoint 不会被迁移**，静默留在原处。`docs/core/autopilot/long-horizon-autonomy.md` §7 迁移表已预警过这一点（"迁移代码需显式扫描候选根（当前 cwd + 已知 workspace 路径），否则迁移本身会漏"）；当前实现只做了 cwd 一半。影响面随时间衰减（旧 checkpoint 有 24h TTL），但对从 <4.0.0 直接升级的宿主是真实的一次性数据丢失。

### G2 — `_writeFailureCount` 无外部暴露点（确认）

`src/state-persister.ts:49-51` 有计数器与 getter，但未见任何 projection / RPC 透出。磁盘满时"恢复能力已失效"这件事对算子不可见。**不确定**：我 grep 了 `getCheckpointWriteFailureCount` 在 `index.ts` 与 `src/` 的引用（除定义外零命中），但没有逐行读 `src/projection.ts` 全文确认它不以别的名字透出。

### G3 — AC-NNN 的 `Verification` 字段与 evidence gate 断开（确认）

AC 机制（4.2.0）让 goal 携带结构化验收标准，含 `Verification:` 字段。但该字段唯一用途是拼进 prompt 文本（`src/acceptance-criteria.ts:107`）。**没有任何代码把 AC 的 verification 转成 `ValidationCommand` 交给 evidence gate 执行。** 于是：一个带 3 条 AC（每条写了 `Verification: vitest foo.test.ts`）的 run，如果 WORKFLOW.md 没配 `validation.commands`，evidence 仍然是 `skipped/not_configured` → `done` + `completionUnverified: true`。**结构化验收标准目前是模型自律，不是 gate。**

> 注意边界：把 AC verification 自动转成可执行命令会碰 ADR-019 的判定边界与 `workflow-config.ts` 的二进制白名单/eval-flag 过滤（`src/workflow-config.ts:55-111` 一带）。这是**设计空白**，不是简单漏实现；本文不给方案。

### G4 — deployed-dist smoke 当前不可执行（确认，已有 issue）

`AGENTS.md:57-58` 与 `CONTEXT.md:66` 都把 "deployed-dist smoke check" 定为"改动是否真的生效"的唯一判据。而该脚本当前**不可用**（仅存在于 MA 悬空 commit，未合入分支），issue #171 跟进。后果：Host Deploy 这条边界目前只有文档约束，没有可跑的验证手段。

### G5 — 长程 loop 的"真能连续多轮转"仍未运行时验证（确认，已记账）

`omm-implementation-status.md:60` 把 T0（loop 活性实跑验证）列为 frontier 剩余项，阻塞原因写的是"非代码，需运行系统"。同文 `:62` 的 T0 重审说明 E6/E7/E4/E2 顶着 T0 标签落地。即：**引擎侧机制齐备且单测全绿，但"无人值守连续跑完一个长任务"这件事本身仍无运行时证据**。这是 ADR/设计文档已记账的已知状态，不是本文新发现——列在此处是因为它决定了前面所有"强"评级的适用范围：**强 = 机制与单测强，不等于生产已验证。**

### G6 — `resolveSessionKey` 双源未审计（确认，代码自认）

`index.ts:584-596` 注释明说移除 event fallback 会打断 8 个模拟生产模式的测试，故"Leaving as-is until a deeper audit of per-hook sessionKey provenance is done"。该审计**仍未做**。这是"hook 拿不到 run"类失效的候选机制，且与 G5 互相遮蔽（loop 没实跑过，所以双源是否真出过错无法确认）。

### G7 — `no_progress` 对纯分析型任务的误报面（确认存在，缓解已就位）

`no_progress` 的输入是 exec-class 过滤后的 ledger 活动（只读工具不记账，`index.ts:905-911`）。纯分析任务（只读代码、只输出结论）天然零 `filesTouched`、零 `commandsRun` → 3 轮后命中 `pause('no_progress')`。缓解措施已在：`no_progress` 属 `RESUMABLE_BLOCKED_REASONS`（`src/orchestrator.ts:32`），`noProgressTurns` 可经 WORKFLOW.md 配 0 关闭（`src/workflow-config.ts:178`）。这是**已知取舍**（误停一个分析任务 vs 放任死循环烧 30 轮），列出是为完整，不是判它为缺陷。

### G8 — 未查项（诚实标注）

- `src/goal-manager.ts`（662 B）未读全文，shallow 与否未定（S3）。
- `src/projection.ts` 只读了 `:6` 与 `:143`（`canResume` 计算），未通读——G2 的结论因此留"不确定"。
- 9 个 patrol 相关测试文件只做了文件名 + grep 级确认，未逐用例读完，故 L2 的"同 tick 交互是否有测试"记为**未确认**而非"缺失"。
- `packages/instinct/` 只读了 `CONTEXT.md` 的描述与 package 存在性，未读源码。
- 4 个 `parse_partial` 文件（`tests/evidence-failopen-wiring.test.ts:7`、`tests/evidence-wiring.test.ts:6`、`tests/permission-wiring.test.ts:6`、`scripts/verify-publish.sh:41`）本文未引用其内容；如后续需要，那些行范围应直读源码。

---

## 4. 与 ADR 的冲突标注

本文的发现**没有**与任何 ADR 冲突。逐条核对：

| 发现 | 与 ADR 的关系 |
|---|---|
| S1（删镜像） | 与 **ADR-016 一致**：加强"唯一真相源"。集合定义留在 reducer 侧是 ADR-016 的方向 |
| L1（grace seam 断开） | 与 **ADR-020 一致**：`progressGrace` 是 coupled aux 字段，ADR-020 要求这类字段走 reducer 唯一写者；当前它被 persister 写、无人读，正是 ADR-020 要消灭的形态 |
| L2（stale snapshot） | 与 **ADR-016 一致**：stale 快照覆写正是 ADR-016 不变式在 reducer 外被绕过的通道 |
| L3（观测轴未进文档） | 与 `autopilot-dynamic-workflows-boundary.md:105` 的自身要求一致（"不得再制造第三种半归并"→ 要么记进文档，要么撤掉）；不动 ADR-014 的权限边界 |
| G3（AC verification 未接 gate） | **触及 ADR-019 边界但不冲突**：ADR-019 定的是"判定留在规则层、不引入独立 LLM 评审员"。把 AC 的 `Verification` 转成**可执行命令**仍在规则层，不越界。但它会改变 `workflow-config.ts` 的命令来源信任模型（从 WORKFLOW.md 扩展到 goal 文本），这是**需要新 ADR 的决策**，不是实现遗漏 |
| G5（loop 未实跑验证） | ADR/status 文档已记账（T0），非新 gap |

---

## 5. 附：证据方法说明

- 结构性发现先走 `search_graph` / 图谱定位，再 `get_code_snippet` / 直读源码确认；配置键名、字面量、非代码文件（ADR / CHANGELOG / .gitignore）全部用 grep 与直读。
- 本文所有 `file:line` 均为 `master @ f58f8ef` 实读得出，非文档转述。这一点是刻意的：`docs/core/autopilot/long-horizon-autonomy.md:14` 已标 **DEPRECATED**（权威版在 MA 仓），且 `omm-implementation-status.md:72` 记载该审计文档的 `file:line` 引用「已随代码移动而漂移（历史记录，不追改）」。**本文未沿用那两份文档的任何行号。**
- 凡本文与旧文档结论不同处（例如旧文档 §2.3 记「墙钟/成本上限 ABSENT」、§4 P0-2 记「checkpoint 根不一致」、§4 P1-11 记「压缩后只剩计数串」），均因 E2/E1/E5 已落地，以当前代码为准。
