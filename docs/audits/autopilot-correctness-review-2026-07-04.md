# Autopilot 模块端到端功能正确性审查 (2026-07-04)

> 范围:`packages/autopilot/` 模块整体(非 diff review)。
> 缘由:经过 7 轮 audit wave(#60-#68)+ 多次安全修复后,对核心运行时做一次端到端功能正确性审视,对照业界最佳实践。
> 方法:code-review skill 双 lane(code-reviewer + architect)并行,主审亲手核实关键发现。
> 配套清单:可执行项见 [`autopilot-fix-checklist.md`](./autopilot-fix-checklist.md) § Wave 5。

## 结论

| 维度 | 结果 |
|------|------|
| code-reviewer 推荐 | **REQUEST CHANGES**(1 个 HIGH 功能 bug) |
| architect status | **WATCH**(dual state machine,非阻塞) |
| **最终** | **REQUEST CHANGES** — HIGH finding 是真实功能缺陷,必须修 |

安全态势扎实(无 CRITICAL):trustWorkspace 边界正确强制、YAML 解析无 eval 风险、路径遍历已防。问题集中在**功能正确性**与**状态模型的可维护性**。

---

## HIGH — evidence gate 失败路径产生假完成 ⚠️

**位置**:`index.ts:495-497` + `orchestrator.ts:198-233`

**现象**:当 validation command 失败时,run 被标记为 `status:'done', enabled:false`,而 orchState 是 `retry_queued`。retry queue 被填入但**永不触发**(stall interval 检查 `state.enabled` 为 false)。orchestrator.ts:210-233 的 retry/block 逻辑成了死代码。

**根因链**(已主审亲手核实):

1. `orchestrator.ts:198-208`:evidence **passed/skipped** → `status:'done'`
2. `orchestrator.ts:210-233`:evidence **failed** → `orchestrationState:'retry_queued'/'blocked'`,但 **`status` 保持 `'running'`**(reducer 没动它)
3. `index.ts:495-497`:检查 `updated.status === 'done'`:
   - passed/skipped → `true` → 只存 evidence(正确)
   - **failed → `false`(status 还是 running)→ 走 else → 调 `complete()`**
4. `complete()` 把 status 设成 `done`、enabled 设成 `false`

**影响**:evidence gate 的全部设计意图是防止"假完成"。失败路径恰恰产生了假完成。任何配置了 validation command 的 WORKFLOW.md 都会触发。**这是 7 轮 audit wave 都没抓到的 bug**——因为 `evidence-wiring.test.ts:156-198` 断言了 `evidenceStatus='failed'` 但没断言 `projection.status`。

**修复方向**:`index.ts:495-497` 改为基于 `orchestrationState` 判断,而非 `status`。failed + retry_queued → 不调 `complete()`(让 retry loop 接手);failed + blocked → `pause()`。补测试断言 `projection.status !== 'done'`。

---

## MEDIUM — 功能/配置缺陷

### M1. `stall_timeout_ms` 配置被解析但从未消费

**位置**:`workflow-config.ts:154-156` + `index.ts:1169`

WORKFLOW.md 的 `stall_timeout_ms` 存进 `workflow.stallTimeoutMs`,但 stall interval 永远用模块级常量 `DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs`。运维设了这个值会被静默忽略。(注:`max_retries` / `max_retry_backoff_ms` 是正确消费的,只有 stall 这一项漏了。)

### M2. `workspace_failed` / `permission_denied` 事件定义但从未 dispatch

**位置**:`orchestrator.ts:237-245` + `types.ts:182,190`

reducer 有处理逻辑,但 index.ts 没有任何代码 emit 这两个事件。Dead code——误导性地暗示一个不存在的 transition。要么 wire 起来(before_tool_call 的 block 分支 dispatch permission_denied),要么删除并文档化"tool block 由 host veto 处理,不经 orchestrator"。

### M3. `claimed` 状态的 stall 不被检测

**位置**:`index.ts:1180,1200`

stall interval 只检查 `orchestrationState === 'running'`。如果 PROD-7 actuator 的 enqueue 失败,run 卡在 `claimed`,只能等 5-10 分钟的 `isRunStuck` fallback 或 24h orphan sweep。recovery gap:autonomous run 多等 5-10 分钟才恢复。

### M4. `register()` 900 行单体,evidence-gate 逻辑内联

**位置**:`index.ts:339-1235`

evidence-gate 的 complete-case(450-501)是最复杂、最易出 bug 的段(HIGH finding 就藏在这里),应提取为命名函数(如 `applyCompleteWithEvidence`)使其独立可测。

---

## LOW — 风格/清理

- **L1** `command-runner.ts:21` — `parseCommandArgs` re-export 无消费者,死导出。
- **L2** `autopilot-state.ts:3` + `continuation-engine.ts:82` — 500-char 截断逻辑重复,缺共享常量。
- **L3** `index.ts:1027,1169` — stall timeout 的 `×2` 条件表达式重复且语义不透明(为何有 token budget 就减半?)。

---

## Architectural WATCH(非阻塞,但 HIGH bug 的结构性根因)

### W1. Dual state machine — reducer 的 single-writer 契约是虚假的

**位置**:`orchestrator.ts:4`(声称 "all state transitions go through this reducer")

实际:`status` 被 **3 套机制**写:
- `autopilot-state.ts` — 5 个 throw-based setter
- `orchestrator.ts` reducer — 也写 status(evidence_finished passed 分支)
- `index.ts` — 8 处直接 `{...state}` spread 绕过两者(207, 386, 496, 589, 779, 826, 856, 870, 910)

**H1 guard**(`index.ts:493` 的 `updated.status === 'done'` 三元)的存在本身就是证据——它防的是 `complete()` 会 throw 的不一致状态。这是 patch,不是 fix。

**HIGH finding 正是 W1 的直接后果**:两套机器对 evidence failed 产生不一致(reducer 说 retry_queued,但 status 保持 running),index.ts 基于 status 做判断就错了。

**建议**:让 reducer 成为 `status` + `orchestrationState` 的唯一 writer,`status` 从 `orchestrationState` 派生(mapping 几乎 1:1)。删除 autopilot-state.ts 的 throw-setter 或降级为 reducer 的 thin wrapper。这是一个较大的重构(21 个 mutation site → 1),需独立规划。

### W2. `needsCrossTurnResume` — 16 write site、3 义的 accreted flag

跨 4 文件(index.ts / orchestrator.ts / autopilot-state.ts / types.ts),承载 recovery-pending / cross-turn-enqueued / degraded-fallback 三种语义。`index.ts:385` 的 clear 是防 infinite-loop 的创可贴(注释明说 NOT clearing 会触发 `sessions.changed` 死循环)。建议建模为显式 orchState 或派生布尔。

### W3. audit-mode 跨插件 refcount 在并发下脆弱

**位置**:`index.ts:281-288`

`maxConcurrentAutopilot:5` 下,session A pause 调 `setAuditMode('active')` 会翻转全局 audit mode,影响 session B 的 tool call 确认。依赖 audit 插件未验证的 refcount clamp 语义。comment(281-284)自己承认 "could go negative"。建议 autopilot 自己持有 refcount,或要求 audit 插件暴露显式的 refcounted-handle API。

### W4. 测试覆盖盲区:纯单元优秀,集成接缝缺失

682 测试对纯函数(orchestrator/retry/continuation)覆盖扎实。但:
- (status, orchState) 合法性不变量:**零测试**
- concurrent stall-vs-hook race:**零测试**(stall interval 只靠 `_triggerRetryCheckForTest` 合成 harness,不模拟真实 setInterval 时序)
- HIGH finding 正是靠集成接缝测试缺失才存活 7 轮 audit

建议:加 invariant 测试(每次 dispatch 后断言 (status, orchState) ∈ legalPairs)+ 1 个并发测试(stall interval 与 mid-flight agent_turn_finished 的 race)。

---

## 本次审查未覆盖

- `permission-policy` / `dynamic-workflows` 模块(本次聚焦 autopilot;前者已有 2026-06-30 安全审查)
- host 侧集成(host-deploy 后的 deployed-dist 行为,本仓库不可见)
- 性能基准(autonomous loop 的长时运行内存/延迟特征,需 host 侧 profiling)
