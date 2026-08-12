# LoopX 引入 OMM 评估与建议

> **Status**: 部分实施 · 2026-08-10 评估 / 2026-08-12 更新进展
> **目的**：评估 `/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/loopx`（huangruiteng/loopx，"open, provider-neutral, stateful control plane for long-running agents"）哪些设计值得引入/吸纳进 oh-my-matrix（OMM）autopilot，并按 `autopilot-verification-floor-design.md` 的三个环节（需求规划/任务拆解/验证）对照补漏。
> **方法**：3 轮 Explore agent 逆向（能力地图 + OMM 对比裁决 + 增量角落深挖）+ 业界最佳实践 Web 对照（human-in-the-loop gate / quota 控制）。
> **关联**：`autopilot-verification-floor-design.md`（§3 验收基线/§4 进展/§1 非目标）· `docs/adr/019-conditional-evidence-judging-boundary.md` · `ecc-intake-recommendation.md`
> **进展跟踪**：实施状态见本文 §7（落地建议表"进展"列）+ §9（实施进展汇总）。详细 ticket / 回归跟踪见 `autopilot-enhancement-design.md` §C1 与 `.scratch/autopilot-enhancement/issues/`

---

## 1. 结论先行

- **LoopX 是本会话评估过的最有参考价值的同领域项目**：真控制平面（Python，无 SQLite、无 LLM、纯标准库、event-sourced），与 OMM autopilot 同领域（长程 agent 状态控制）——远高于 ECC（内容包）的参考价值。
- **10 个吸纳点全部不撞 OMM 既有决策**（ADR-019 延迟模型判定 / §1 无规划阶段 / 零运行时依赖 / OpenProse sole runtime）。
- **3 个高价值立项候选**：human gate（填 OMM 唯一真判断洞）、windowed slot quota（解 E2 token 硬上限死结）、验证纪律组（证据绑定真结果）。
- **三环节增量（本轮新增）**：需求规划 = goal 验收标准字段（轻量）；任务拆解 = successor chaining / `openItems` 用起来（**唯一不撞"无规划阶段"决策的拆解增量**）；验证 = 已闭环，增量为 LoopX 验证纪律组。

---

## 2. LoopX 概览（同领域控制平面）

- provider-neutral：Codex/Claude Code/Cursor/自建 runtime 执行 bounded turns，控制平面管理 objectives/gates/todos/evidence/quota/handoffs。
- 确定性：完成/资格由**可重放状态机**决定（markdown+JSON 事件日志，**零 LLM judge**）；每个主观决策强制变成**具体可回答的人类问题**（approve/reject/defer）——"Keep the judgment human"。
- Event-sourced：11 种事件类型 + 重放投影 + `exclusive_file_lock`；quota ledger 由事件重放重建——控制平面可无状态重建。
- Turn-as-transaction：7 相位（host_execute→typed_result→validation→durable_writeback→quota_spend→scheduler_apply→scheduler_ack）+ sha256 typed receipts。
- Provider-neutral 实现 = **contract 即抽象**（一个 should-run packet 驱动所有 host）。Claude adapter **拒绝原生 /goal**（"transcript 判断完成与确定性 gate 冲突"——与 OMM completion-detector 弱点同病）。

---

## 3. 吸纳清单（10 点，全部不撞 OMM 决策）

### 3.1 验证纪律组（证据必须绑定真结果）

| # | 吸纳点 | LoopX 机制 | OMM 缺口 | effort |
|---|---|---|---|---|
| 1 | **Fingerprint-bound diff 收据** | `skills/loopx-change-quality/SKILL.md:143-175`：prepare→fingerprint→至多一次 safe-fix→**re-prepare（旧收据失效）**→收据→canary premerge。"旧指纹收据不证明新 diff" | agent_end 验证结果未绑定最终 diff（验证的是"某时刻的代码"） | S |
| 2 | **Ledger-output backstop on regex 完成** | completion=记录证据，非措辞猜测（`completion_fence.py:8-40`） | `isTaskComplete` 命中时要求最近 ledger entry 有实际产出（commandsRun>0/filesTouched>0）才信 | S |
| 3 | **Turn receipt algebra + 两段 fail-closed 验证** | `control_plane/turn_driver/transaction.py:276-364` + `executor.py:246-344,406-538`：validation 纯函数→`commit_eligibility{writeback,quota_spend,scheduler_ack}`；material 需 completed validation；no-spend 永不 spend；validator 抛错/garbage→inconclusive→repair_required | evidence→quota 流缺"先验证后记账"排序纪律 | S-M |
| 4 | **Evidence-coupled turn 记账** | spend-only-after-validated-writeback（`README.md:415-418`） | 现在每轮都计 continuation，验证失败也算 | S |

### 3.2 human/quota 组（OMM 两大缺口）

| # | 吸纳点 | LoopX 机制 | OMM 缺口 | effort |
|---|---|---|---|---|
| 5 | **Human gate（人类判断门）** | `operator_gate.py:19-21,109-165`：approve/reject/defer + **resume contract**（freshness_check + decision_point_rebase_only，拒绝回滚只 rebase）；`waiting_on=user_or_controller→state=operator_gate`（`quota.py:394-403`） | free-text goal 无 ground truth；OMM 无"等人判"状态。**不撞 ADR-019**（延迟的是 in-loop 模型判定；human 是 ground truth，D2 明确认可 OrchestratorEvent 注入路径） | M |
| 6 | **Windowed 可退 slot quota** | `quota.py:292-311,318-371,1002-1030` + `docs/quota-allocation.md:24-41`：插件可数单位（continuations/window）+ throttle 非 terminal + 窗口滚动自动恢复 + **voiding 退款**（证据失败退 quota） | **E2 token 硬上限卡死**（host telemetry 不可靠 S10）——token 记账不可靠，continuation 窗口计数是确定性替代 | M |

### 3.3 工程健壮性组

| # | 吸纳点 | LoopX 机制 | OMM 缺口 | effort |
|---|---|---|---|---|
| 7 | **Checkpoint schema versioning** | `state_migration.py`（350 行） | state-persister 无 schemaVersion；3.0.0 trustWorkspace flip 已示范失败类 | S |
| 8 | **Atomic journal + content-addressed 幂等** | `executor.py:548-558`（mkstemp+os.replace）+ `event_sourced_state.py:565-599`（内容派生 event_id + StateEventConflictError + 流 checksum） | checkpoint 缺原子替换 + 重跑去重 | S |
| 9 | **exact-head cursor（防伪造进度）** | `capabilities/pr_review_queue/core.py:280-351,420-497`：`handled_exact_heads` 键 `NUMBER@HEAD_OID`，每观察至多一候选，硬拒未投影自先前候选的"已处理"声明 | agent_end evidence 去重/防 agent 声称未分配的工作 | S |
| 10 | **Dual-mode real-binary regression** | `regression/external-evidence-observation-real-codex.py` + `run-regressions.py`：默认纯契约 + opt-in 真 CLI（隔离 fixture + timeout + 断言机器 JSON） | OMM 无 plugin hook-dispatch 真实 smoke（836 测试全 in-memory） | S-M |

---

## 4. 三环节对照（`autopilot-verification-floor-design.md`）

### 4.1 需求规划（goal 侧）——设计文档未覆盖，本轮增量

现状：`goal: string` free-text（500 字符，`types.ts:334`），无结构无验收标准（ADR-019 D1 "no predicate to judge against"）。

| 参考 | 来源 | 建议 |
|---|---|---|
| **goal 验收标准字段**（轻量） | LoopX `goal_vision.py:14-33`（vision/role_scope/**acceptance_summary**/advancement_policy，1200 字符上限）融合 ECC AC-NNN | **引（轻量）**——goal 创建时带"怎么算达成"；比 AC-NNN 完整结构轻，比 free-text 强；是 T05 的轻量版 |
| Human 裁判 | LoopX operator_gate + 业界 3-checkpoint | 已列（#5） |
| 完整 AC schema / spec 文档流 | ECC intent-driven / spec-kit | YAGNI（human gate 落地后自然需要）/ 范畴不符 |

### 4.2 任务拆解——保持不做，唯一不撞决策的增量

现状：明确不做（`effort-injection.ts:43-44` "NO planning phase" + §4 OpenProse sole runtime）。

| 参考 | 来源 | 建议 |
|---|---|---|
| **Successor chaining（done 必答下一步）** ⭐ | LoopX `completion_policy.py:23-72`（done todo 必须命名 successor）+ todos `resume_when: todo_done:/pr_merged:` | **引（轻量）**——执行时追踪非规划阶段，不撞决策。**直接映射 `progress-ledger` 恒空的 `openItems` 字段**：每轮结束时模型声明未完成项/下一步 |
| checklist 执行时拆 | zcode /goal | 同 successor 思想，被覆盖 |
| Ralphinho WorkUnit / PWF phases | ECC / PWF | 撞决策（规划阶段 + OpenProse sole runtime），不引 |

### 4.3 验证——已闭环，增量为验证纪律组

现状：§3 三步已实现 + 修复（skipped 两因/evidence_missing/resume 守门）。增量 = §3.1 验证纪律组（fingerprint receipt 最值——验证结果绑定最终 diff）。

---

## 5. 业界最佳实践验证（LoopX 方向正确）

**Human-in-the-loop（2026 共识）**：[3-Checkpoint 框架](https://dev.to/sahil_kat/where-to-gate-your-ai-coding-agent-a-3-checkpoint-framework-1ob0#comments)（Plan/Findings/Diff gate）、[渐进自治](https://productleadersdayindia.org/blogs/managing-ai-coding-agents/human-in-the-loop-approval-gates.html)（低风险自由/高风险 sign-off，**不过度 gate**）、approval=阻塞 vs notification=信息、[nonce-bound auditable approvals](https://github.com/Optim-Agent/optim-plans)（append-only 事件日志——与 LoopX typed receipts 同思想）、durable pause-and-replay（跨请求存活——与 LoopX resume contract 同思想）、**SDK 级强制胜过 prompt**（CLAUDE.md 指令 ~15 次工具调用后失效）。

**Quota/预算（2026 共识）**：[staged enforcement](https://github.com/pykul/tokencap)（advisory→soft gate→hard gate→actuals-only）、long-running 实践（dailyTokenBudget/kill switch/maxIterations/adaptive heartbeat/[cost-aware model downgrade](https://github.com/reaatech/agent-budget-controller)——OMM 已有 `resolveModelTier` 降级路径可接）、**state vs context 分离**（[O(N²) context 累积是最大成本陷阱](https://machinelearningmastery.com/identifying-token-costs-hiding-in-your-agentic-loop/)——OMM 的 compaction+ledger 正是此实践）、多 scope 配额（tightest applicable）。

**对照结论**：human gate 定位应遵循渐进自治（非所有暂停都要人，只在真决策点）+ 阻塞式 + timeout；E2 quota 走 staged（advisory→downgrade→hard）接现有 resolveModelTier；验证纪律组呼应"proof of execution ≠ proof of correctness"（[dev.to](https://dev.to/moonrunnerkc/ai-coding-agents-lie-about-their-work-outcome-based-verification-catches-it-12b4)）。

---

## 6. 不吸纳（诚实）

- capabilities 大多 domain-specific：content_ops / ml_experiment / value_connectors / material_lifecycle / doc-registry / semantic_preference。
- worker_bridge 容器机制（mounts/preflight/simulator）——benchmark harness 机器。
- reward_memory runtime——设计纪律参考级（"confidence 不升 authority"/"memory 不覆盖 gate"/append-only run overlay），非代码。
- Dashboard UI——只借 freshness-check/loopback-only/preview-lock 纪律。
- replan/dreaming——撞"无规划阶段"决策。

---

## 7. 落地建议

| 优先级 | 项 | 关联 ticket/设计 | 进展（2026-08-12） |
|---|---|---|---|
| 🔴 立项 | **Human gate**（#5） | 新 `waiting_human` blocked reason（resumable）+ `humanQuestion` 投影字段 + `human_gate_decided` OrchestratorEvent；业界渐进自治定位（真决策点才 gate） | ⏳ ticket 01 ready-for-agent（跨 host） |
| 🔴 立项 | **Windowed slot quota**（#6） | E2 落地；`maxContinuationsPerWindow` + 证据失败退款 + throttle（resumable）非 terminal；staged：advisory→downgrade（接 resolveModelTier）→hard | ⏳ ticket 03 ready-for-agent（blocked by 02 回归清理） |
| 🟡 并进 evidence 流程 | 验证纪律组（#1-4） | fingerprint receipt 最值（agent_end 证据绑定最终 diff）；ledger backstop 一 guard（continuation-engine）；evidence-coupled 记账 | ⚠️ 混合：#4 evidence-coupled ✅（ticket 02，但有回归→12）；#1 fingerprint ⏳（ticket 04）；#2 ledger backstop 🚫 blocked（ticket 05，记账模型限制）；详见 §9 |
| 🟡 轻量 | **goal 验收标准字段**（§4.1）+ **successor chaining/openItems**（§4.2） | T05 轻量版；`openItems` 用起来（progress-ledger 恒空字段） | 🟡 goal 字段 ✅（ticket 06，master bdf4815）；successor chaining ⏳（ticket 07，跨 host） |
| 🟢 工程健壮 | #7-10 | schemaVersion/原子幂等/exact-head cursor/dual-mode regression（hook-dispatch smoke） | 🟡 #7 schemaVersion ✅（ticket 08，含 F3 真修复）；#8 原子幂等 ✅（复用既有）；#9 exact-head ⏳（ticket 09，跨 host）；#10 regression ⏳（ticket 10，跨 host） |

---

## 8. 实施进展（2026-08-12）

本评估催生 13 个 ticket（`.scratch/autopilot-enhancement/issues/01-13`）。实施情况：

### ✅ 已实施（4 项）

| ticket | 吸纳点 | commit | 说明 |
|---|---|---|---|
| **06** goal 验收字段 | §4.1 | master `bdf4815` | goal AC-NNN 轻量版（零 schema 变更） |
| **11** size-classifier | 工程健壮 | master `22c9e23` | task-size 分类（autopilot 4.3.0 发布） |
| **02** evidence-coupled 记账 | #4 / §3.1 | `feacd81`（loopx worktree） | `lastProgressTurn` 读 evidence，churn-but-never-pass 仍 trip no_progress。**但有 3 CONFIRMED 回归 → ticket 12** |
| **08** checkpoint schemaVersion + F3 | #7 / 工程健壮 | `5a56f46` + `438bcf9`（loopx worktree） | schemaVersion + migration + evidence 恢复 + **F3 真修复**（migration grace flag） |

### ⚠️ 部分完成（1 项）

| ticket | 吸纳点 | 说明 |
|---|---|---|
| **12** 02 回归修复 | 验证纪律组后续 | **F6 ✅**（`skipped`+`not_executed` 不算 progress，`d74fcf4`）；**F3 ✅**（package 侧 grace 机制）；**F1/F2/F7-算术/F8 🏠 host-runtime-blocked**（agent_end/patrol/setAuditMode 不在本 package） |

### 🏠 host-runtime-blocked（需 host repo）

F1（stale `'failed'` stamping）/ F2（audit refcount over-release）/ F8（wiring 测试）/ F7 gap 算术 —— 在 host gateway `index.ts`，不在 `@oh-my-matrix/autopilot` npm package。

### ⏳ ready-for-agent / blocked（7 项）

- **01** human gate / **04** fingerprint receipt / **07** successor chaining / **09** exact-head cursor / **10** regression smoke —— ready-for-agent，但核心 enforcement 跨 host
- **03** windowed slot quota —— ready-for-agent，blocked by 02 回归清理
- **05** ledger-output backstop —— 🚫 blocked（02 记账模型根本限制）
- **13** mid-run validation writeback —— ready-for-agent，blocked by 12 的 F1

### 关键决策（surface per AGENTS.md "Invisible Decision"）

1. **worktree 边界**：F1/F2/F8 留 host，不硬写手建假测试（F8 要求非手建 agent_end→patrol wiring）
2. **F6 语义**：未盲从 ticket"只有 passed/undefined 算"的一刀切——按 `evidence-gate.ts` 实际语义区分 `skipReason`，`not_configured`（项目没配验证）仍算 progress，只 `not_executed`（配了被丢弃）不算
3. **F3 两轮**：首轮 migration normalize（`undefined→0`）被 code-review 抓出是 no-op（= 旧 bug 行为），二轮加 `progressGrace` transient + 谓词真修

---

## 9. 引用

- **LoopX 源**：`/Users/guanxueliang/Desktop/Matrix/DynamicWorkflow/loopx` `control_plane/`（turn_driver/transaction.py、operator_gate.py、quota.py、event_sourced_state.py、todos/、goals/goal_vision.py）· `capabilities/`（pr_review_queue/core.py、change_quality、reward_memory/architecture.py）· `skills/loopx-change-quality/SKILL.md` · `regression/` · `apps/presentation/dashboard` · `worker_bridge.py` · `docs/quota-allocation.md` · `docs/architecture.md`
- **OMM 内部**：`autopilot-verification-floor-design.md` · `docs/adr/019-conditional-evidence-judging-boundary.md` · `docs/core/autopilot/long-horizon-autonomy.md`（§5.4/§5.5/§5.6、E2）· `effort-injection.ts:43-44`（无规划阶段）· `progress-ledger.ts`（openItems 恒空）· `projection.ts`（canResume）· `state-persister.ts`（无 schemaVersion）
- **业界**：[3-Checkpoint human gate](https://dev.to/sahil_kat/where-to-gate-your-ai-coding-agent-a-3-checkpoint-framework-1ob0#comments) · [渐进自治](https://productleadersdayindia.org/blogs/managing-ai-coding-agents/human-in-the-loop-approval-gates.html) · [nonce-bound approvals](https://github.com/Optim-Agent/optim-plans) · [tokencap staged enforcement](https://github.com/pykul/tokencap) · [agent-budget-controller downgrade](https://github.com/reaatech/agent-budget-controller) · [O(N²) context trap](https://machinelearningmastery.com/identifying-token-costs-hiding-in-your-agentic-loop/) · [outcome-based verification](https://dev.to/moonrunnerkc/ai-coding-agents-lie-about-their-work-outcome-based-verification-catches-it-12b4)
