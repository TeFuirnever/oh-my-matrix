# Autopilot 修复执行清单

> 配套审计报告：[autopilot-e2e-audit-2026-07-01.md](./autopilot-e2e-audit-2026-07-01.md)
> 生成：2026-07-02 | 来源：3 轮 17 个 scientist agents + 对抗性验证
>
> **本文件是跨 session 的持久化载体。** TaskList 待办绑定单个 session（`~/.claude/tasks/session-*/`），
> 新开 session 加载不到。逐步修复时以本清单为准，完成一项勾一项。

## 执行波次建议

先清零风险快速修复（Wave 1），再做独立中型项（Wave 2），最后攻大重构（Wave 3）和跨包/文档（Wave 4）。

---

## Wave 1 — 快速修复 ✅ 完成 2026-07-02

- [x] **#1 [P0] 统一 runId 生成** — `index.ts:982` 改为 `generateRunId()`。✅
- [x] **#4 [P1] dynamic-workflows sessionKey fail-closed** — 缺失 sessionKey 返回 `{ block: true }`。+2 测试。✅
- [x] **#5 [P1] dynamic-workflows hook 加 try/catch** — 确认 subagent 后包裹，异常 fail-closed。✅
- [~] **#7 [P1] destructiveGit.allow 门控** — **评估后不修**。permission-policy 的 containment check 已把 destructive git 限制在 workspace 内（blast radius = 攻击者自己目录）；真正 RCE 向量（validation execFile）已被 trustWorkspace 门控；强制门控会破坏 autopilot 在自己 worktree 做 git 管理的合法功能。SEC-10 实为 containment-缓解的 LOW。
- [x] **#10 [P1] YAML workspace.root 穿越校验** — 加 `..` 拒绝护栏（保留绝对路径）。⚠️ 注：该字段当前是死代码（autopilot 委托 host 管 worktree，ADR-008），此为 trust-boundary 纵深防御。+2 测试。✅

**Wave 1 验证**：autopilot 50 files / 669 tests 绿 + dynamic-workflows 28 tests 绿 + 两包 typecheck 通过。

## Wave 2 — 独立中型项（无跨任务依赖）

- [x] **#8 [P1] vitest coverage 配置** — `vitest.config.ts` 加 coverage block + 阈值（60%），已装 `@vitest/coverage-v8`。基线：91.73% stmts / 84.11% branches / 96.59% funcs。✅
- [x] **#22 [P2] autopilot event-shape 契约** — 加 `src/event-shape.contract.ts`，编译时 pin `PluginHookBeforeToolCallEvent`。✅ typecheck 通过=契约成立。
- [~] **#9 [P1] 完成检测器短格式模式** — 中文否定守卫 + E5 widening 已在 PR #60 合入。剩余"Done!/Finished."短格式**评估后不加**：这两个词在 mid-task 输出中极常见（"Done! Now let's move on…"），假阳性风险远大于漏检收益；当前 7 个英文 + 3 个中文模式已覆盖绝大多数真完成。
- [~] **#16 [P2] tool-error-tracker 交替错误** — **评估后不改逻辑**。「连续相同 tool+args 失败」是有意的精确 stuck 信号；改宽（只比 tool/总数）会误停正常试错（假阳性 > 漏检交替，后者有 maxTotal 兜底）。已加注释文档化盲区为有意取舍。
- [x] **#17 [P2] magic numbers 统一** — orchestrator.ts 3 处 `?? 300000` 改为 `DEFAULT_WORKFLOW_CONFIG.maxRetryBackoffMs`；index.ts 4 处改为 `DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs`（及其 `* 2`）。✅
- [x] **#18 [P2] 子 agent token 归并** — enforce 本已在 `continuation-engine.ts:61`（agent RES-10「不 enforce」前半误报）。真实修复：`llm_output` 复用 `before_model_resolve` 的父 session 解析，子 agent token 计入父 budget。+1 测试。✅
- [x] **#19 [P2] cleanupAll refcount 过度释放** — 只对 `status==='running'` 释放 audit refcount。✅（PR #60 已合入）
- [x] **#20 [P2] 驱逐 FIFO→LRU** — 改按 `lastActivityAt`（真 LRU），更新注释和测试描述。✅
- [x] **#21 [P2] logger object 结构** — JSON mode 下 `log(obj)` 分离对象→ctx（保留结构）+ emitJson 加 circular/BigInt 防护。+2 测试。（DX-8「关键路径改 logWithContext」的批量迁移未做，留 backlog。）✅
- [x] **#15 [P2] evidence gate 可观测性** — 保留 fail-open（ARCH-13 防 zombie，catch 几乎永不触发），但消除静默：错误升 `error` 级 + `failureReason` 进结构化日志，监控可区分「正常 skip」vs「评估错误 skip」。**未采纳 agent 的 fail-closed 建议**（有 zombie 风险）。✅

## Wave 3 — 大重构（有依赖，需完整回归）

- [~] **#2 [P1] 双状态机统一** — **评估后不做（2026-07-02）**。#6 修复后 orchState 已能正确走到 `done`，唯一残留冲突是 H1 guard（`index.ts:445` 一行条件判断，已文档化）。统一需改 ~15 处调用 + 29 个测试，换来的是代码更漂亮而非功能更正确。host UI 契约未确认，盲改有回归风险。**重开时机**：下一个需要新增状态（如 `cancelling`）的功能需求到来时，统一是必要的而非纯重构。
- [x] **#6 [P1] orchestrationState 卡 claimed + evidence bypass** — 两个 bug 修复：(1) `agent_turn_prepare` 未 persist `agent_turn_started` 的 orchState 转换（仅在 goal capture 路径 setState，无 goal 时变更丢失）；(2) `before_agent_finalize` complete case 缺少 `agent_turn_finished` dispatch，running 无法到 released→done。现在 orchState 正确完成 claimed→running→released→done 全链路。更新 lifecycle 测试从 frozen-to-claimed 改为断言 'done'。✅
- [x] **#3 [P1] before_agent_finalize 拆分** — 提取 `buildCrossTurnReviseFallback()` 消除 cross_turn 3 处 revise-fallback 重复代码（含统一英/中混用的 fallback 字符串为一致的英文）。✅

## Wave 4 — 跨包 + 文档

- [x] **#11 [P2] 三重 tokenizer 统一** — `workflow-config.ts` 删除 `tokenizeCommand`、`command-runner.ts` 删除 `parseCommandArgs`，两处改为 import `tokenizeShell` from `@oh-my-matrix/permission-policy`。`parseCommandArgs` 保留为 re-export alias（向后兼容测试 import）。无需 version bump（`tokenizeShell` 已在当前版本导出）。✅
- [x] **#12 [P2] test helpers 移出 barrel** — package.json 加 `exports` map 阻止外部 deep import；`generateRunId()` 不再委托 `_generateRunIdForTest()`（直接内联 `run-${crypto.randomUUID()}`）。✅
- [x] **#13 [P2] README 扩充** — 完整 README：plugin config 参考表（10 项）、6 个 gateway method 合约、WORKFLOW.md 格式示例、AutopilotProjection 字段表、troubleshooting。✅
- [x] **#14 [P2] hook handler 类型化** — 12 个 hook handler 从 `event: any, ctx: any` 改为 OpenClaw SDK 类型（PluginHookBeforeAgentFinalizeEvent 等）；提取 `resolveSessionKey()` helper 兼容 production ctx 路径和 test mock event 路径。✅

---

## 第二轮 E2E 对抗审查（2026-07-02）—— Wave 5–7

> 独立于上方 #1–#22（那是 2026-07-01 的 17-agent 审计）。本轮 6 scientist + 3 对抗 code-reviewer，
> 编号 PROD/LOGIC/ARCH/API/TEST/SEC。**完整报告**：[autopilot-e2e-review-2026-07-02.md](./autopilot-e2e-review-2026-07-02.md)。

### Wave 5–7 ✅ 完成（690 tests 绿）

- [x] **[P0] PROD-7 stall 恢复死路** — reducer 设 `needsCrossTurnResume` 不够（那是消费型防重复标记非触发器）；真正闭环靠 actuator `kickResumedTurn`（`index.ts:103`）在 stall interval / resume gateway 实际 `enqueueNextTurnInjection`。PR #65→**#66**（#65 半成品，#66 修正）。
- [x] **[P1] LOGIC-3 完成检测器误匹配** — `completion-detector.ts:92` 加负向前瞻阻断 past-participle（"task finished/done"）。PR #65。
- [x] **[P1] PROD-1 config 错误静默** — `workflow-config.ts` catch 写入 `ioWarnings` 携带返回。PR #65。
- [x] **[P1] LOGIC-4 resume 卡 claimed** — resume gateway 调 `kickResumedTurn`。PR #65→#66。
- [x] **[P2] PROD-2 cleanup 泄漏** — `sessionExtension.cleanup` 补删 sessionKeyToRunId/canaryFired +测试。PR #67。
- [x] **[P2] PROD-6 stallInterval unref** · **PROD-3/4 日志 INFO→WARN** · **API-4 peer dep 上界** · **API-6 具名类型** · **API-7 删死代码**。PR #67。
- [x] **[P2] PROD-5 goal PII** — 日志记 `goalLen` 不记内容。**PROD-9 YAML 递归** — 空行跳过改迭代 +测试。PR #68。

### 对抗推翻的假阳性（不修）

`ARCH-14`（interval 无 try/catch，Node 不会停）· `API-1 功能层`（host 不读 manifest 校验 hook）· `LOGIC-2`（用本地副本不读 Map）· `LOGIC-6`（上游保证非负）· `LOGIC-5`（共享 counter 是有意安全帽）· `LOGIC-1`（race 结果恒正确）。详见报告。

### 剩余 backlog（🔵 需设计/规划，接手上下文见报告）

- [ ] **ARCH-4 双状态机统一** — PARTIALLY，纯气味非 bug，与 #2 同结论（defer 到需新增状态时）。
- [x] **TEST-1 coverage 阈值** 60→88/78/90/88（已在本 branch 完成）。
- [ ] **TEST-2 源码扫描测试→行为测试** · **TEST-3 index.ts 分支 74.8% 补测** · **TEST-7 e2e 正名**。
- [x] **SEC-5 git --work-tree containment**（已完成：完整 global-flag stripping，含 --bare/-p/--exec-path 等所有 man git flag）。
- [x] **PROD-8 audit 磁盘写 fail-silent**（已完成：`getAuditWriteFailureCount()` 导出，barrel 不导出 reset helper）。
- [ ] **API-5 gateway per-method 参数类型**（LOW，内部 RPC）。
- [~] **API-2 test helpers 泄漏 dist** — **接受现状**：有 NODE_ENV guard，仅类型 cosmetic；干净修需移私有状态=重构非 quick fix。

---

## Wave 8 — 代码审查新发现（2026-07-03）

> 来源：8 角度 finder + 独立 verifier 对抗验证。4 CONFIRMED / 1 PLAUSIBLE。
> **涉及文件**：`packages/autopilot/index.ts`、`packages/autopilot/src/orchestrator.ts`、`packages/autopilot/src/workflow-config.ts`、`packages/permission-policy/src/permission-policy.ts`。

### Correctness（需修复）

- [ ] **[P1] REV-1 resume unclaimed 静默 no-op** — `orchestrator.ts:261` `resume_requested` case 只处理 `blocked→claimed`，`orchestrationState='unclaimed'`（dispatch 前 pause 的 run）进入后 return state 不变 → `kickResumedTurn` 再次 early-return（guard `!== 'claimed'`）→ `respond(true, {ok:true})` 仍触发，调用方看到 success，run 实际永远卡住。**修复**：`resume_requested` 同时处理 `'unclaimed'` → `'claimed'` 转换。

- [ ] **[P1] REV-2 kickResumedTurn TTL 与 stall 超时不匹配** — `index.ts:113` TTL 硬编码 `DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs`（300s），但 `!config.tokenBudget` 时 stall 检测用 `stallTimeoutMs * 2`（600s）。injection 在 300s 过期，host 在 300–600s 内启动 resumed turn → injection 已消失 → run 卡 `'claimed'` 直到 24h orphan 清理。**修复**：`kickResumedTurn` 接收已计算的 `stallTimeoutMs` 参数而非 hardcode 默认值。

- [ ] **[P1] REV-3 PROD-1 修复实际静默失效（call site 读错字段）** — `index.ts:999` 读 `result.config.warnings`，但 all-paths-fail 时 `loadWorkflowConfig` 返回 `{ config: DEFAULT_WORKFLOW_CONFIG, warnings: ioWarnings }`，`DEFAULT_WORKFLOW_CONFIG.warnings = []`，ioWarnings 在 `result.warnings` 永远不被读取。**修复**：`index.ts:999` 改为读 `result.warnings`（或统一在 workflow-config.ts 把 warnings 嵌入 config 对象）。

- [ ] **[P2] REV-4 多路径搜索时第一条路径的 I/O 错误静默丢弃** — `workflow-config.ts:478` success return 不含 `ioWarnings`：第一条路径失败（error 推入 ioWarnings）→ 第二条成功 → `return { config: merged, warnings }` 仅含 parseAutopilotSection warnings。**修复**：`return { config: merged, warnings: [...ioWarnings, ...warnings] }`。

### Efficiency（可改进）

- [ ] **[P3] REV-5 boolean git flag 用内联 array `.includes()` 而非 Set** — `permission-policy.ts:242` while-loop 每次迭代分配新的 14 元素数组做线性扫描，与同文件 `GIT_BINARIES`/`GIT_TOOLS` 的 `new Set([...]).has()` 模式不一致。**修复**：提取 `const GIT_BOOLEAN_GLOBAL_FLAGS = new Set([...])` 到模块顶层，改用 `.has(a)`。（注：altitude 建议的 `a.startsWith('-')` fallback 在双 token flag 场景有 fail-open 风险，不采用。）


---

## Wave 5 — 端到端功能正确性审查 (2026-07-04)

> 来源：[`autopilot-correctness-review-2026-07-04.md`](./autopilot-correctness-review-2026-07-04.md)
> 双 lane(code-reviewer + architect)模块级审查。**HIGH 必须修;MEDIUM/WATCH 是中长期债务。**

### 必修(evidence gate 假完成)

- [x] **H1 [P0] evidence gate 失败路径产生假完成** — `index.ts:495-497` 基于 `updated.status === 'done'` 判断,但 evidence failed 时 reducer 保持 `status:'running'`,落入 else 调 `complete()`,导致 retry_queued 的 run 被错误标 done + enabled:false,retry 永不触发。**修复**:改为基于 `evidenceSummary.status === 'failed'` 判断——failed+blocked → pause('validation_failed');failed+其他 → 保持 running+enabled(让 retry loop 接手);passed/skipped → complete(原行为)。+`'validation_failed'` PauseReason。测试加固:failed 路径断言 `status==='running'` + `enabled===true`。✅ (TDD red→green, code-review APPROVE+CLEAR)。这是 W1(dual state machine)的直接后果。

### 应修(配置/恢复 gap)

- [x] **M1 [P1] `stall_timeout_ms` 配置被解析但从未消费** — ✅ Done (PR #77)。stall interval + isRunStuck 现在读 per-run `state.workflow?.stallTimeoutMs`,不再用全局 default。默认 timeout 从 600s(旧 ×2 global)改为 300s(config 实际值)。
- [x] **M2 [P2] `workspace_failed`/`permission_denied` 事件 dead code** — ✅ Done (PR #79)。文档化:tool block 由 host before_tool_call veto 处理,reducer 事件保留为 API surface(test-covered)。
- [ ] **M3 [P2] `claimed` 状态 stall 不被检测** — `index.ts:1180` stall 只查 `running`。PROD-7 actuator enqueue 失败时 run 卡 claimed,等 5-10min fallback。**修复**:stall 检查扩展到 `claimed`(更长阈值),或加 claimed watchdog。
- [ ] **M4 [P2] evidence-gate complete-case 提取为命名函数** — `index.ts:450-501` 内联逻辑(H1 bug 藏身处)提取为 `applyCompleteWithEvidence(state, runId, now)`,独立可测。

### 架构债务(非阻塞,但建议规划;HIGH 的根因)

- [x] **W1 [P1-arch] dual state machine collapse** — ✅ Done (PR #76, ralplan consensus + TDD)。reducer 现在是 status 的 sole writer(post-switch `deriveStatus` wrapper),5 个 setter 全部 derive。H1 根因(两 field 不一致)结构上消灭。+78 测试(deriveStatus 表 + pause mapping + status invariant)。**剩余长尾**(非阻塞,作为 follow-up):
  - [ ] **W1a** production index.ts 仍调 5 个 setter(8 处)而非 dispatch reducer events——status 值已安全(derived),但调用路径未全部路由。Phase 2 完整版。
  - [x] **W1b** `agent_turn_finished` error path lossy fallback — ✅ Done (PR #78)。新增 `unrecoverable_error` BlockedReason(non-resumable),error path fallback 从 `validation_failed` 改为 `unrecoverable_error`。terminal error 不再被误分类为可恢复。
  - [ ] **W1c** loop-breaker branch-A/B e2e 未写(Critic N1:circuit-breaker 实际 non-recoverable,branch-A 基本不可达;若写 branch-A 测试需用 "timeout" 而非 "circuit breaker" 字符串)。
- [ ] **W2 [P2-arch] `needsCrossTurnResume` 16 write site / 3 义** — 建模为显式 orchState 或派生布尔,消除 index.ts:385 的 infinite-loop 创可贴。
- [ ] **W3 [P2-arch] audit-mode refcount 并发脆弱** — `index.ts:281` 跨插件 refcount,maxConcurrent:5 下 session 间互相干扰。建议 autopilot 自持 refcount。
- [~] **W4 [P2-arch] 集成接缝测试缺失** — (status,orchState) invariant 测试已加(`status-invariant.test.ts`,W1 PR #76)。剩余:stall-vs-hook 并发测试仍缺(TOCTOU 是 pre-existing,非 W1 引入)。

### LOW(清理)

- [ ] **L1** `command-runner.ts:21` `parseCommandArgs` 死导出,删除。
- [ ] **L2** `autopilot-state.ts:3` + `continuation-engine.ts:82` 500-char 截断缺共享常量。
- [x] **L3** `index.ts:1027,1169` stall timeout `×2` 表达式重复且语义不透明 — ✅ Done (PR #79)。提取为 `defaultStallTimeoutMs(hasTokenBudget)` 命名 helper,×2 rationale 文档化。


---

## 每项完成的 DoD（Definition of Done）

1. `corepack pnpm -r test` 全绿（⚠️ 用 `corepack pnpm`，用户级 pnpm 会 hang）
2. `corepack pnpm -r typecheck` 通过
3. 非平凡逻辑改动带回归测试
4. 完成后回本清单勾选 + `TaskUpdate status=completed`

## 未做成待办的 backlog（P3，报告中记录，按需再提）

goal-manager pass-through 删除 · 24h orphan 清理误删 paused · 退避加 jitter · configSchema 补字段描述 · index.ts:54/98 bare catch{} 加日志 · YAML BOM/lone-CR/多 `---` edge case · setGoal/cleanup gateway 文档化 · maxConcurrent:0 语义文档化
