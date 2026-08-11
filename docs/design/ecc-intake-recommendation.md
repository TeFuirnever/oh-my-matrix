# ECC 引入 OMM 评估与建议

> **Status**: Proposed · 2026-08-08
> **目的**：评估 `/Users/guanxueliang/Desktop/Matrix/ContextEngineering/ECC`（affaan-m/ECC v2.0.0，"harness-native operator system"）哪些特性值得引入 oh-my-matrix（OMM，openclaw 插件），并给业界最佳实践映射下的落地优先级。
> **方法**：3 轮 Explore agent 逆向（整体可行性 + 能力地图 + 3 组特性深挖），用 grilling 建立的"接入/移植/依赖 + 不引理由"框架裁决。
> **关联**：`autopilot-verification-floor-design.md`（§5.4/§5.5 落地）· `docs/adr/019-conditional-evidence-judging-boundary.md` · `docs/core/autopilot/long-horizon-autonomy.md` §5

---

## 1. 结论先行

- **ECC 不可作为 npm 依赖 / openclaw 插件引入**——分类 = **reference-only**。本质是内容/规则包（279 skills + 67 agents + 94 commands），非可执行 runtime；OMM 是 openclaw hook runtime，不同类制品。
- **4 个特性值得移植**：3 个轻量（S effort，拷 markdown/表，不撞决策）+ 1 个子系统（M-L，闭合第三缺口）。
- **业界最佳实践落地优先级**：先 **§5.4（Default-FAIL）+ §5.5（结构化 progress）**——业界最一致共识、OMM 真 defect、零框架；其余实践 OMM 已有 / 有理由延迟 / 撞边界 / 属第三缺口。

---

## 2. ECC 整体裁决：reference-only

| 维度 | 事实 | 裁决 |
|---|---|---|
| `.openclaw/` 目录 | 570 字节 README stub，文档化"markdown 复制进 `~/.openclaw/`" | 无 `openclaw.plugin.json`、无 snake_case TS hook、无 `"openclaw"` package.json 字段；全仓 hook handler grep 零命中 |
| npm `ecc-universal` | CLI + 内容包，非运行时库，无 `exports` | 装 it 拉 3 runtime deps（`@iarna/toml`/`ajv`/`sql.js` WASM）→ **打破 OMM 零运行时依赖原则** |
| 跨 harness 策略 | 一个 markdown 核心 + per-harness "文件落哪"目录；仅 `.claude-plugin`/`.codex-plugin`/`.opencode` 有真可执行适配器 | openclaw tier = 纯 file-copy，**不接 hook** |
| 许可 | MIT | 拷/移植合法，须 attribution |

**分类**：(d) reference-only，或 (b) 手拷选定 markdown skill。**非 npm dep、非 openclaw-native plugin。**

---

## 3. 可引入特性（深挖结果）

### 3.1 值得引入（4 个，按价值×可移植）

| # | ECC 特性 | 裁决 | OMM 价值 | effort | 机制 + graft 点 |
|---|---|---|---|---|---|
| 1 | **continuous-learning instinct** | (b) 重实现概念 | **高——闭合第三缺口（context 记忆，OMM 真空）** | M / L | `observe.sh` 绑 Pre/PostToolUse 捕获 tool/input/output → `observations.jsonl`（10MB rotation/30天 purge/secret scrub）；后台 Haiku 提取 instinct YAML（confidence 0.3-0.85/domain/scope，project_id=git-remote 哈希前 12 字符）；promote(≥2 projects avg≥0.8)/evolve(cluster→skill)。**唯一 blocker = 后台 Haiku 进程**（openclaw 插件进程内无 headless cheap-agent 原语）→ 缓解：移到 `before_agent_finalize`/`agent_turn_prepare` 注入 `appendContext` 让主 agent 提取（最 openclaw-native）。OMM graft：新包 `@oh-my-matrix/instinct`；observer 复用 `permission-policy/audit-persister.ts`（JSONL+rotation）；项目检测 sha256[:12] TS 移植（~20 行）；自循环守卫复用 `isSubagentSessionKey`。**ponytail**：先 observer(S)+extractor(M)，promote/evolve YAGNI until ≥3 projects |
| 2 | **intent-driven AC-NNN** | (a) 拷 markdown | 中高——给 `goal:string` 结构化谓词 | S | AC schema（Scenario/Action/Expected/Must-not/Verification method/Priority）。ADR-019 D1 说 `goal:string` 是 free-text "no predicate to judge against"——AC-NNN 给谓词格式。纯方法论零 hook 依赖。**caveat**：Verification method 须映射 runnable command 才闭合（回路 §5.4/evidence-gate） |
| 3 | **orch-pipeline size-classifier** | (a) 拷 4-row 表 | 中——按**任务形状**路由 effort（**非规划**） | S | 3 信号（files-touched × new-dep/contract × design-ambiguity）→ 4 tier（trivial/small/standard/large）→ 哪些 phase 跑。映射现有 `resolveThinkingIntensity()`（`effort-injection.ts:46-54`），作 `agent_turn_prepare` leaf 或 `AutopilotState` 字段，`totalContinuations<=1` 时分类一次。**正因为不是规划才存活** §4 |
| 4 | **eval-harness 方法论** | (b)-lite 拷 prompt | 中——goal-level DoD 形状 | S | define-before-coding + pass@k/pass^k + 4-grader taxonomy（code=bash/rule=regex/model=LLM-judge/human）。**model-grader 自动化勿建** = ADR-019 deferred 路径；code/rule grader 已是 OMM validation commands。方法论作 skill 拷，自动化属 ADR-019 领土 |

### 3.2 不值得引入（5 个）

| 特性 | 一句理由 |
|---|---|
| **verification-loop** | 冗余——6 bash 相位 = OMM `runValidationCommands` + `workflow-config.ts` 已通用做（duplicate §5.4） |
| **Ralphinho RFC-DAG** | 冲突 §4（OpenProse sole runtime + no controller/scheduler）；纯 prompt 无码，credited 外部 @enitrat；decompose+DAG+tier-pipeline = 第二 workflow runtime |
| **plan-orchestrate** | blocked——硬依赖 ECC `/orchestrate` + agent catalogue（planner/architect/tdd-guide/code-reviewer）OMM 无 |
| **delivery-gate** | orthogonal——`Stop` hook 无 openclaw 干净对等（最接近的 `before_agent_finalize` 但 per-run 非 per-session）；查 session 卫生（learning-lib mtime/disk/rationalization regex）非 goal 完成；rationalization regex 自承 warning-only 易误报 |
| **recursive-decision-ledger** | weak fit——trading/rollout/stochastic-search 问题；OMM 已有 3 state 机制（status-sole-writer ADR-016 / evidence-gate / continuation-engine），移植 = 第四个 |

---

## 4. 业界最佳实践 → OMM 映射

业界长程 agent harness 共识（Anthropic effective-harnesses + cwc + loop-engineering + ECC + zcode）：

| # | 业界实践 | OMM 现状 | 该不该学 |
|---|---|---|---|
| 1 | **Default-FAIL / prove-don't-assert**（cwc, Anthropic） | evidence-gate 在但 `skipped==passed`→done | **必做**（§5.4 已设计） |
| 2 | **Maker/checker 分离**（cwc evaluator, loop-engineering） | ADR-019 已 deferred | **不做**——延迟是合理工程判断（capability 不可行 + cost/benefit），非疏漏 |
| 3 | **结构化可追踪 subtask**（Anthropic feature-list + `passes:boolean`） | 单 goal 非 feature-list；`progress` 计数串 | **§5.5**（OMM 版：单 goal 形态的结构化台账） |
| 4 | **文件持久化跨 context**（cwc PROGRESS+git, PWF） | `state-persister` 原子 JSON + compaction 快照 | **已有** |
| 5 | **hook 强制非习惯**（PWF, ECC delivery-gate） | 12 hook 已注册；evidence-gate 未接 blocking 门 | **§5.4 接门** |
| 6 | **Context 记忆/学习**（ECC instinct, Anthropic fresh-context） | **真空** | 第三缺口，单独立项（§3.1 #1） |
| 7 | **渐进自治 L1→L2→L3**（loop-engineering） | autopilot 本就渐进（retry/stall/evidence） | **已有** |
| 8 | **operator-only 危险迁移**（openclaw Goal, zcode） | pause/blocked 迁移 | 核对（§5.4 resume 守门已触及） |

---

## 5. 三档建议

### 🔴 必做（业界共识 #1 + OMM 真 defect + 零框架）
- **§5.4 `skipped≠passed`** —— "prove-don't-assert" 在 OMM 的落地。性价比最高。详见 `autopilot-verification-floor-design.md` §3（三步：skipReason 区分 + evidence_missing 可达 + resume 守门）。
- **§5.5 最小子集：progress 结构化**（`index.ts:1128`）—— "结构化追踪"的 OMM 版。一行起：`files: <写类文件> | <尾摘要>`。

### 🟡 选做（业界推崇 + 轻量 + 不撞决策，放大必做项价值）
- **AC-NNN 谓词格式**（ECC intent-driven，S 拷）✅ 已实施（2026-08-11，commit bdf4815）—— 给 `goal:string` 结构化谓词，让 §5.4 有物可判。AC 块内嵌 goal 字符串，零 schema 变更。
- **size-classifier**（ECC orch-pipeline，S 拷 4-row 表）✅ 已实施（2026-08-11，commit 22c9e23）—— 按任务形状路由 effort，喂 `resolveThinkingIntensity`。确定性精简版（信号词+goal 长度+AC 数 → 4 tier），trivial 降 effort。
- 二者是 §5.4/§5.5 的**输入侧增强**——不加也成立，加了判得更准。

### 🟢 不做（业界推崇但 OMM 有理由 / 撞边界 / 新缺口）
- **fresh-context evaluator** —— ADR-019 deferred + 须另开 ADR-022。
- **完整规划 / Ralphinho** —— 撞 §4（OpenProse sole runtime）。
- **continuous-learning instinct** —— 独立第三缺口（M-L 新包 `@oh-my-matrix/instinct`），不在本轮两缺口内。长期价值最高，ponytail：先闭合两缺口再议。

---

## 6. 纠正：ADR-019 misattribution

前序研究误将"不加规划"归给 ADR-019。**ADR-019 = `conditional-evidence-judging-boundary`（model-level 证据判定），非规划决策。** 真实规划约束是 3 个独立陈述：

| 位置 | 实际陈述 | 性质 |
|---|---|---|
| `effort-injection.ts:43-44` + `model-routing-thinking-intensity-design.md:273` | "NO dedicated planning phase... initial turns"；分解 inline 发生 | **描述性**（非决策） |
| `dynamic-workflows-projection-design.md §4` | "Do not build controller/scheduler/custom JS runtime" + "OpenProse 是唯一 workflow runtime" | **binding** |
| `model-routing-thinking-intensity-design.md:287` | OMM **期望** goal decomposition（inline，非 phase） | 期望 |

另：`dynamic-workflows` 包 = OpenProse 的 **guard + state projector**（`before_tool_call` priority 11），非 fan-out 引擎；11 patterns/refute gate 在 OpenProse（外部）。

---

## 7. 落地顺序

1. **§5.6 在飞守卫**（前置，防 TOCTOU）—— 若未实施。
2. **§5.4 + §5.5 最小子集**（🔴 必做）—— 详见 `autopilot-verification-floor-design.md`。
3. ~~AC-NNN + size-classifier~~（✅ 已实施 2026-08-11，autopilot 4.2.0/4.3.0）。
4. **continuous-learning instinct**（若立项第三缺口）—— 独立 spike：新包 `@oh-my-matrix/instinct`，先 observer + turn-boundary extractor，验证 openclaw hook 对等 + 是否做子系统。

---

## 8. 引用

- **ECC 源**（reference-only）：`ContextEngineering/ECC/` `.openclaw/README.md`（570B stub）· `package.json`（ecc-universal, 3 runtime deps）· `skills/continuous-learning-v2/` + `scripts/hooks/observe-runner.js` + `observe.sh` + `observer-loop.sh` + `instinct-cli.py` · `skills/eval-harness/SKILL.md` · `skills/intent-driven-development/SKILL.md` · `skills/orch-pipeline/SKILL.md` · `skills/autonomous-loops/SKILL.md` §6 · `skills/delivery-gate/` + `hooks/quality-gate.py` · `skills/verification-loop/SKILL.md` · `skills/plan-orchestrate/SKILL.md` · `skills/recursive-decision-ledger/SKILL.md`
- **OMM 内部**：`autopilot-verification-floor-design.md` · `docs/adr/019-conditional-evidence-judging-boundary.md` · `long-horizon-autonomy.md` §5.4/§5.5/§5.6 · `dynamic-workflows-projection-design.md` §4 · `effort-injection.ts:43-54` · `evidence-gate.ts:23-95` · `index.ts:1128`(progress)/`:528`(before_agent_finalize) · `permission-policy/audit-persister.ts` · `dynamic-workflows/index.ts:57`(isSubagentSessionKey)
- **业界**：[Anthropic effective-harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [cwc-long-running-agents](https://github.com/anthropics/cwc-long-running-agents)（demo）· [loop-engineering](https://github.com/cobusgreyling/loop-engineering) · [zcode /goal](https://zcode.z.ai/en/docs/goal)
