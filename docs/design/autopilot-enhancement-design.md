# Autopilot 增强设计（verification-floor 落地 + LoopX 引入）

> **Status**: Part A 已实施核验（2026-08-09/10）· Part B 引入评估（2026-08-10/11）· Part C 待办路线
> **合一来源**：`autopilot-verification-floor-design.md`（已落地设计，被本文件取代）+ `loopx-intake-recommendation.md`（引入评估，被本文件取代）
> **关联**：`docs/core/autopilot/long-horizon-autonomy.md` §5.4/§5.5/§5.6/§5.12 · `docs/adr/019-conditional-evidence-judging-boundary.md` · `docs/audits/openclaw-native-vs-autopilot-2026-08-05.md`（E4+E7/E5）· `ecc-intake-recommendation.md`（ECC 评估，参考）

---

## Part A —— 已落地（verification-floor）

## A1. 背景与裁决

用户问：oh-my-matrix 是否缺「任务拆解/规划」与「验收/verify」两块能力。研究结论（5-agent 对抗 review + 3 轮外部逆向）：两块缺口真实但**不对称**，且**早有既有 ticket 与设计**（`long-horizon-autonomy.md` §5.4/§5.5）。

**对抗 review 共识**：所有外部落地方案 FLAWED——Task Flow（路径错 `.flows` 只读/`managedFlows` deprecated/解决已解决/范畴错状态机≠planner）、PWF（4 行映射假/与 §5.5 冲突/注入面）、cwc evaluator（ADR-019 延迟/capability 不可行）、progress-only-text（冗余）、ralplan（enforcement 焊死 OMC）。host `goal_manager` 是 ADR-007/008 文档吹嘘（symlink 指向本仓自身）。

**裁决**：不引外部，直接实施既有 §5.4 + §5.5 最小子集。ponytail 最短路径，零新依赖/框架/hook。

## A2. 范围与非目标

**范围内**：§5.4 验收基线（skipped 两因 + resume 守门）· §5.5 进展台账 · §5.6 在飞守卫（前置）。

**非目标**：❌ Task Flow checkpoint 根 · ❌ PWF ledger · ❌ fresh-context evaluator（ADR-019 延迟，另开 ADR-022）· ❌ progress-only-text 检测器 · ❌ autopilot 加"规划/拆解阶段"（`effort-injection.ts:43-44` "NO planning phase" + `dynamic-workflows-projection-design.md` §4 "OpenProse 是唯一 workflow runtime"）。

## A3. 验收基线 —— §5.4 三步（已实现 + 修复）

### A3.1 skipped 两因（`orchestrator.ts:257-295` ✅ 已实现）

| `skipped` 成因 | 处置 | 理由 |
|---|---|---|
| **从未配置**命令（`commands.length === 0`） | `done` + `completionUnverified: true` | 无测试项目合法 |
| **配置了没跑成**（`commands.length > 0` 无有效结果） | `blocked` + `evidence_missing` + `completionUnverified: false` | 真风险；blocked 非 completion，信号由 blockedReason 承担 |

- 显式 `skipReason: 'not_configured' | 'not_executed'` 字段（不匹配字符串）。
- fail-open 分支（evaluation error）归 not_executed 一侧（fail-closed for completion）。

### A3.2 evidence_missing 可达（✅ 已实现）

`VALID_BLOCKED_REASONS` + `RESUMABLE_BLOCKED_REASONS`（state-persister:432）已含，无需改。resumable。

### A3.3 resume 守门（✅ 已实现 + 对抗 review 修复）

- 设计要求：reducer no-op → gateway INVALID_REQUEST；setter 收缩为清副状态。
- **修复**（2026-08-09，review 实证"门 INVERTED"）：gateway reducer 后检查 `orchestrationState !== 'claimed'` → INVALID_REQUEST；**reducer sole writer**（gateway 不调 `resume()` setter，构造 resumed 补 `enabled:true` + 清副状态 + deriveStatus）。附带：stop 对 paused/done 的 audit 双释放修复。
- `projection.ts` 透出 `completionUnverified` + **`canResume`**（`RESUMABLE_BLOCKED_REASONS.has(blockedReason)` + `orchestrationState==='blocked'` guard）。
- ⚠️ 行为破坏性变更：§5.12 按钮条件须同批（host 侧）。

### A3.4 测试

新增：`resume-gateway.test.ts`（非可恢复拒绝/no_progress 可恢复成功）· `evidence-failopen-wiring.test.ts`（fail-closed）· canResume×4 · marker 生命周期×2 · headline/容量。lifecycle T10 改 terminal 拒绝语义。966 测试绿。

## A4. 进展结构化 —— §5.5（✅ 已实现，超预期：完整 ledger 非最小子集）

- `src/progress-ledger.ts`：LedgerEntry{turn/filesTouched/commandsRun/evidenceStatus/**openItems**}，容量折叠（8 files/4 cmds/entry，12/8 summary），`buildProgressHeadline`（RPC-safe 人读摘要），`summarizeLedger`（JSON 注入）。
- 消费点：`index.ts:1289`（agent_end）+ `continuation-engine.ts`（summarizeLedger 注入）。
- 数据源纪律：filesTouched 只取写类工具（`commandClass` 过滤），只读不记（防分析任务误报活动）。
- 瞬态不落盘：`inFlightToolStartedAt` 不入 checkpoint（重启即工具死）。

## A5. 在飞守卫 —— §5.6（✅ 已实现）

`inFlightToolStartedAt` 置位（before_tool_call allow / validation 期）/ 清零（after_tool_call / agent_end / before_agent_finalize / **stall_timeout**——防恢复 turn 继承 30min cap）。E6 dir-2 `no_progress` 生产力检测也在（orchestrator.ts:33 + state-persister:561）。

## A6. 对齐清单

| # | 约束 | 状态 |
|---|---|---|
| 1 | PauseReason 映射 total（编译安全网） | ✅ 无需改 |
| 2 | BlockedReason/VALID_BLOCKED_REASONS | ✅ evidence_missing 已在 |
| 3 | RESUMABLE allowlist | ✅ 5 项 |
| 4 | projection canResume/completionUnverified | ✅ 已实现 |
| 5 | resume setter 收缩 + §5.12 同批 | ✅ setter 已绕开；§5.12 host 侧 |
| 6 | §5.6 先于/同批 §5.4 | ✅ |

## A7. 实现状态核验（2026-08-09/10）

| 改动 | 状态 | 证据 |
|---|---|---|
| §5.6 在飞守卫 | ✅ 已实施 | index.ts:268/811/912/920/1293 |
| §5.4a skipped 两因 | ✅ 已实施 | orchestrator.ts:257-295 + evidence-gate.ts:34 |
| §5.4b resume 守门 | ✅ 已实施+修复 | orchestrator.ts:399-419 + gateway + resume-gateway.test.ts |
| §5.5 progress ledger | ✅ 已实施（超预期） | progress-ledger.ts + index.ts:1289 |
| canResume | ✅ 已实施 | projection.ts |

验证：`pnpm verify` 全绿（966 测试 + lint + typecheck + docs:build）。

---

## Part B —— 引入评估（LoopX + 业界）

## B1. LoopX 概览（同领域控制平面）

`/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/loopx`（huangruiteng/loopx，MIT，Python，无 SQLite/无 LLM/纯标准库）：provider-neutral 状态化控制平面。确定性状态机管理 objectives/gates/todos/evidence/quota/handoffs；event-sourced（11 事件类型 + 重放投影）；turn-as-transaction（7 相位 + sha256 typed receipts）；"Keep the judgment human"（主观决策强制变成具体人类问题）。Claude adapter 拒绝原生 /goal（transcript 判断完成与确定性 gate 冲突——与 OMM completion-detector 弱点同病）。

## B2. 10 个吸纳点（全部不撞 OMM 决策）

### 验证纪律组（证据绑定真结果）

| # | 吸纳点 | LoopX 机制 | OMM 缺口 | effort |
|---|---|---|---|---|
| 1 | **Fingerprint-bound diff 收据** | `loopx-change-quality`：prepare→fingerprint→至多一次 safe-fix→re-prepare（旧收据失效）→收据→canary premerge | agent_end 验证结果未绑定最终 diff | S |
| 2 | **Ledger-output backstop on regex 完成** | completion=记录证据非措辞 | `isTaskComplete` 命中时要求最近 ledger 有实际产出 | S |
| 3 | **Turn receipt algebra + 两段 fail-closed 验证** | `transaction.py:276-364`：validation 纯函数→commit_eligibility；material 需 completed validation；no-spend 永不 spend；validator 抛错→inconclusive→repair | evidence→quota 缺排序纪律 | S-M |
| 4 | **Evidence-coupled 记账** | spend-only-after-validated-writeback | 每轮都计 continuation | S |

### human/quota 组（OMM 两大缺口）

| # | 吸纳点 | LoopX 机制 | OMM 缺口 | effort |
|---|---|---|---|---|
| 5 | **Human gate** | `operator_gate.py:19-21,109-165`：approve/reject/defer + resume contract（只 rebase 不回滚）；`quota.py:394-403` operator_gate 状态 | free-text goal 无 ground truth；无"等人判"状态。**不撞 ADR-019**（human 是 ground truth，D2 认可 OrchestratorEvent 路径） | M |
| 6 | **Windowed 可退 slot quota** | `quota.py:292-311,318-371,1002-1030`：插件可数单位（continuations/window）+ throttle 非 terminal + 窗口滚动恢复 + voiding 退款 | **E2 token 硬上限卡死**（host telemetry 不可靠 S10） | M |

### 工程健壮组

| # | 吸纳点 | LoopX 机制 | OMM 缺口 | effort |
|---|---|---|---|---|
| 7 | **Checkpoint schema versioning** | `state_migration.py` | state-persister 无 schemaVersion | S |
| 8 | **Atomic journal + content-addressed 幂等** | mkstemp+os.replace + 内容派生 event_id + StateEventConflictError | checkpoint 缺原子替换 + 重跑去重 | S |
| 9 | **exact-head cursor** | `pr_review_queue/core.py:280-351`：`handled_exact_heads` 键 `NUMBER@HEAD_OID`，硬拒未投影的"已处理" | agent_end evidence 去重/防伪造 | S |
| 10 | **Dual-mode real-binary regression** | 默认纯契约 + opt-in 真 CLI（隔离 fixture+timeout+机器 JSON） | 无 plugin hook-dispatch 真实 smoke | S-M |

## B3. 三环节对照（按本文件 Part A 的规划）

### 需求规划（goal 侧）——未覆盖，增量

现状：`goal: string` free-text（500 字符，无验收标准，ADR-019 D1 "no predicate"）。

| 参考 | 来源 | 建议 |
|---|---|---|
| **goal 验收标准字段** | LoopX `goal_vision.py:14-33`（acceptance_summary）融合 ECC AC-NNN | **引（轻量）**——goal 带"怎么算达成"；T05 轻量版 |
| Human 裁判 | LoopX operator_gate + 业界 3-checkpoint | 已列（#5） |
| 完整 AC schema / spec 文档流 | ECC intent-driven / spec-kit | YAGNI / 范畴不符 |

### 任务拆解——保持不做，唯一不撞决策的增量

现状：明确不做（effort-injection.ts:43-44 + OpenProse sole runtime）。

| 参考 | 来源 | 建议 |
|---|---|---|
| **Successor chaining（done 必答下一步）** | LoopX `completion_policy.py:23-72` + todos `resume_when:` | **引（轻量）**——执行时追踪非规划阶段；**映射 `openItems`（progress-ledger 恒空字段）**：每轮结束声明下一步 |
| checklist 执行时拆 | zcode /goal | 被 successor 覆盖 |
| Ralphinho / PWF phases | ECC / PWF | 撞决策，不引 |

### 验证——已闭环（Part A），增量为 B2 验证纪律组

fingerprint receipt 最值（验证结果绑定最终 diff）。

## B4. 业界最佳实践验证（LoopX 方向正确）

- **Human-in-the-loop（2026 共识）**：渐进自治（不过度 gate）、3-Checkpoint（Plan/Findings/Diff）、approval=阻塞 vs notification=信息、nonce-bound auditable approvals、durable pause-and-replay、SDK 级强制胜过 prompt。
- **Quota（2026 共识）**：staged enforcement（advisory→soft→hard→actuals-only）、long-running 实践（dailyTokenBudget/kill switch/adaptive heartbeat/**cost-aware downgrade**——OMM 已有 resolveModelTier 可接）、state vs context 分离（O(N²) context 陷阱——OMM compaction+ledger 正是此实践）。
- **验证**：proof of execution ≠ proof of correctness（outcome-based verification）。

## B5. 不吸纳

capabilities 大多 domain-specific（content_ops/ml_experiment/value_connectors）；worker_bridge 容器机制；reward_memory runtime（设计纪律参考级）；dashboard UI（只借 freshness-check/loopback/preview-lock 纪律）；replan/dreaming（撞无规划决策）。ECC 整体 = 内容包非 runtime（reference-only，详见 `ecc-intake-recommendation.md`）。

---

## Part C —— 落地路线（ticket 依据）

| 优先级 | 项 | 说明 |
|---|---|---|
| 🔴 立项 | **Human gate**（#5） | `waiting_human` blocked reason（resumable）+ `humanQuestion` 投影 + `human_gate_decided` OrchestratorEvent；业界渐进自治定位（真决策点才 gate）+ 阻塞式 + timeout |
| 🔴 立项 | **Windowed slot quota**（#6） | E2 落地：`maxContinuationsPerWindow` + 证据失败退款 + throttle（resumable）；staged：advisory→downgrade（接 resolveModelTier）→hard |
| 🟡 并进 evidence 流程 | 验证纪律组（#1-4） | fingerprint receipt 最值（agent_end 证据绑定最终 diff）；ledger backstop 一 guard；evidence-coupled 记账 |
| 🟡 轻量 | **goal 验收标准字段** + **successor chaining/openItems** | T05 轻量版；`openItems` 用起来 |
| 🟢 工程健壮 | #7-10 | schemaVersion / 原子幂等 / exact-head cursor / dual-mode regression（hook-dispatch smoke） |

---

## 引用

- **已实现**：`packages/autopilot/`（orchestrator.ts / evidence-gate.ts / progress-ledger.ts / projection.ts / index.ts / state-persister.ts）+ `tests/`（resume-gateway / evidence-failopen-wiring / projection / progress-ledger / evidence-wiring / crash-recovery-wiring）+ `long-horizon-autonomy.md` §5.4/§5.5/§5.6/§5.12
- **LoopX**：`/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/loopx`（control_plane/turn_driver/transaction.py、operator_gate.py、quota.py、event_sourced_state.py、goals/goal_vision.py、capabilities/pr_review_queue、skills/loopx-change-quality、regression/、docs/quota-allocation.md）
- **业界**：[3-Checkpoint](https://dev.to/sahil_kat/where-to-gate-your-ai-coding-agent-a-3-checkpoint-framework-1ob0#comments) · [渐进自治](https://productleadersdayindia.org/blogs/managing-ai-coding-agents/human-in-the-loop-approval-gates.html) · [nonce-bound approvals](https://github.com/Optim-Agent/optim-plans) · [tokencap](https://github.com/pykul/tokencap) · [O(N²) context trap](https://machinelearningmastery.com/identifying-token-costs-hiding-in-your-agentic-loop/) · [outcome-based verification](https://dev.to/moonrunnerkc/ai-coding-agents-lie-about-their-work-outcome-based-verification-catches-it-12b4)
