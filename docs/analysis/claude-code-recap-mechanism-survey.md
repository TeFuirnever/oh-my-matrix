# Claude Code 的 "Recap" 与业界防漂移机制研究

> **类型**：非约束性分析报告（Non-binding analysis）
> **日期**：2026-07-21
> **状态**：Analysis（非 Design、非 ADR）
> **方法**：2 个并行后台 research agent（Claude Code recap 机制核实 + 业界防漂移最佳实践调研）+ 4 人对抗 review team（Scope / Source Integrity / Synthesis / Repo Conventions）独立核实
> **范围声明**：回答"Claude Code 是否用 recap 防偏差"，对照业界防漂移最佳实践。**不产出代码、不推翻任何 ADR、不对 OMM 下任何产品决策。** §6 全部以问句呈现，不构成建议。

---

## 0. Lede —— 直接回答用户问题

> **用户观察**："我识别到 Claude Code 会使用 recap 方式保证不偏差？"

**你的观察对了一半。** Claude Code 确实有维持连贯的机制，但严格意义上叫 **compaction**，不是 `/recap`。两者容易混淆，因为都叫"摘要"，但消费者完全不同：

- **`/recap`（Session Recap / "away summary"）是给人看的** —— 用户离开终端回来后，Claude Code 生成一份"你不在的时候发生了什么"的摘要，帮你重新定位。
- **Compaction（`/compact` + auto-compact + microcompaction）是给模型看的** —— 对话逼近 context 窗口上限时，把历史摘要成 `<summary>` 块，**re-feed 进后续 turn**，让模型继续工作。

> 金句：**compaction summarizes what happened; `/recap` re-asserts why we're here.**

Anthropic 官方原话（一手，Critic 2 独立 WebFetch 逐字核实）：

> *"In Claude Code, for example, we implement this by passing the message history to the model to summarize and compress the most critical details."*
> —— [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**更关键的一点（必须标注为诠释性推论，非单一一手源直接支持）**：compaction 本身只防 **context-overflow 漂移**（token 预算耗尽导致的功能崩溃），**不直接防 goal drift**（agent 忠实地带着压缩 context 继续偏离原目标）。现有引用源中，Lost in the Middle 讲的是检索位置效应、Reflexion 讲的是错误纠正，均未直接建立"compaction 不防 goal drift"这一论断。这是本笔记作者的推论，依据是 compaction 摘要的对象（近期活动）与 goal drift 所需保护的（原始意图）之间存在结构性 gap。见 §5 反模式。

---

## 1. Claude Code 的两个"摘要"机制（消费者不同，不可混淆）

### 1.1 `/recap`（Session Recap / away summary）—— 给人

| 维度 | 事实 | 来源 |
|---|---|---|
| 命令 | `/recap`（on-demand）；同时有 auto-recap，用户离开后回来自动出现 | [code.claude.com/docs/en/commands](https://code.claude.com/docs/en/commands)（一手，Critic 2 核实） |
| 环境变量 | `CLAUDE_CODE_ENABLE_AWAY_SUMMARY`（telemetry-disabled 时强制启用） | GitHub issue [#48084](https://github.com/anthropics/claude-code/issues/48084) 引用 CHANGELOG 2.1.108 原文 |
| 发布版本 | **2.1.108 一次性发布**（含 `/recap`、`/config` 开关、环境变量）；2.1.110 加 telemetry-disabled 启用；2.1.113 修 auto-fire bug；研究时 head = 2.1.215 | CHANGELOG raw，Critic 2 核实 |
| 内部命名 | `away-summary` / `post_turn_summary` | GitHub issue #55863（Critic 2 检索） |

**UNCONFIRMED（Critic 2 要求保留，不能漂移成断言）：**
- 内部源文件路径 `src/services/awaySummary.ts` —— Claude Code 闭源/混淆，无法从公开渠道独立核验
- ~3 分钟 away 自动触发阈值 —— 未在官方文档找到具体数字
- ~20,000 token recap 预算 —— 近似值，未核验

### 1.2 Compaction（`/compact` + auto-compact + microcompaction）—— 给模型

| 维度 | 事实 | 来源 |
|---|---|---|
| 手动 | `/compact`（可选带 `[instructions]` 引导摘要重点） | [code.claude.com/docs/en/commands](https://code.claude.com/docs/en/commands) |
| 自动 | auto-compact，对话逼近窗口阈值时自动触发 | [code.claude.com/docs/en/context-window](https://code.claude.com/docs/en/context-window) |
| 摘要去向 | 摘要成 `<summary>` 块，**re-feed 进后续 turn** —— 摘要本身成为模型后续工作 context 的一部分 | [platform.claude.com/docs/en/build-with-claude/compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) |
| microcompaction | "tool result clearing"，清除陈旧 tool 结果，**不需要模型调用** —— Anthropic 称其为 "one of the safest lightest touch forms of compaction" | [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| 其他命令 | `/clear`（清空历史）、`/context`（查看当前 context 用量） | [code.claude.com/docs/en/commands](https://code.claude.com/docs/en/commands) |

**UNCONFIRMED（保留）：**
- auto-compact ~95% 阈值 —— 广为流传但本次研究未在官方一手文档核验到具体数字
- "hardcoded 不可配置" —— GitHub issue #15719 / #18360 提及，但非官方文档明示

### 1.3 与其他防漂移机制的关系（互补，不同层）

Claude Code 的防漂移不是单点，是分层组合：

| 机制 | 层 | 职责 |
|---|---|---|
| `/recap` | 人机交互 | 人离开后重新定位 |
| Compaction | 模型 context | token 预算管理 + 跨 turn 连贯 |
| TodoWrite | 模型自状态 | 结构化任务清单，每 turn 自查 |
| Plan mode | 流程护栏 | 编辑前强制计划审批 |
| Subagents | 上下文隔离 | 子任务跑在独立 context 窗口 |

它们**互补**而非替代。Anthropic 在 context-engineering 帖中把 compaction、context editing、subagents、结构化 state 都归入"context engineering"伞下，呈现为协调工具包而非二选一。

---

## 2. 业界防漂移参考点（3 个精选，非全面图谱）

> 说明：用户原文是"**参考**业界最佳实践"，非"全面综述"。本节精选 3 个最相关参考点。完整 7 类技术图谱（含 ReWOO / MemGPT / Generative Agents / ReadAgent 等）见本笔记早期 review 草稿，按对抗 review 建议精简。

### 2.1 Peer coding-agent 对比：Aider / Cursor / Cline

| Agent | 机制 | 来源 |
|---|---|---|
| **Aider** | **repo map**：用 tree-sitter 解析代码库为符号图，PageRank-like 算法排序，按 token 预算注入 top-k 符号 —— 这是**预算化的结构性预压缩**，而非运行时摘要 | [aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html) |
| **Cursor** | compaction（与 Claude Code 同族思路），细节为闭源商业实现 | （业界共识，无一手源可引） |
| **Cline** | 显式 **Plan / Act 双模式**：Plan 模式只读探索 + 提问，Act 模式执行已批准计划 —— 强制在写代码前对齐 | [docs.cline.bot/core-workflows/plan-and-act](https://docs.cline.bot/core-workflows/plan-and-act) |

### 2.2 Reflexion（学术对照，最接近"自我纠错防漂移"）

- **论文**：[arXiv:2303.11366](https://arxiv.org/abs/2303.11366)，Shinn et al., NeurIPS 2023（Critic 2 核实为一手原始论文）
- **机制**：失败后生成自然语言"反思"，存入 episodic memory buffer，下一 trial 时 prepend 进 context —— 论文自称为 "verbal reinforcement learning"
- **证据**：HumanEval 91% pass@1（abstract 级，超越 GPT-4 的 80%）；AlfWorld / HotpotQA SOTA 在论文正文（Critic 2 建议区分 abstract 与正文 claim）
- **关键区分**：Reflexion 是 **intra-agent 跨 trial** 的失败-反思-重试循环，依赖**外部反馈信号**（env reward / error message），不是纯 self-review

### 2.3 Anthropic 多 agent 研究系统（最强业界证据）

官方原话（完整恢复，Critic 2 修正了之前被误标"逐字"的删节版）：

> *"a multi-agent system with Claude Opus 4 as the lead agent and Claude Sonnet 4 subagents outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval"*
> *"multi-agent systems use about 15× more tokens than chats."*
> *"Subagents facilitate compression by operating in parallel with their own context windows, exploring different aspects of the question simultaneously before condensing the most important tokens for the lead research agent."*
> —— [Anthropic, How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

**矛盾点（不回避）**：Cognition（Devin 团队）公开主张 [don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents)（2025-06-12），后发部分撤回 "Multi-Agents: What's Actually Working"。

**真正综合**：**任务条件性**。多 agent 在子任务**信息可隔离、结果可验证**的场景（研究、并行探索）胜出；单 agent 在子任务**共享工作记忆**的场景（多数 coding）更可靠。Anthropic 的 +90.2% 是在 research eval 上测的，不应读作对 compaction 充分性的判决。

---

## 3. Claude Code vs 业界参考点（去类比化）

> ⚠️ 本节**不做"等价映射"**。对抗 review（Critic 3）指出：强行类比会产生虚假精度。仅标注"功能接近"与"层不同"。

| Claude Code 机制 | 与 §2 的关系 | 说明 |
|---|---|---|
| Compaction | **层不同** | within-session token-management，与 Reflexion / 多 agent / repo map 解决的问题不在同一层，非同族 |
| Subagents | **与 §2.3 同族** | 都是 orchestrator-worker 上下文隔离模式 |
| TodoWrite | **≠ Reflexion** | 仅共享 "write" 和 "跨 turn 持久"两个表面属性；Reflexion 是失败-反思-重试循环，TodoWrite 是任务清单持久化，问题域不同 |
| Plan mode | **≠ ReWOO** | 共享 "plan before act" 是陈词滥调；ReWOO ([arXiv:2305.18323](https://arxiv.org/abs/2305.18323)) 优化 token economy via inter-step independence，plan mode 是 human alignment gate |

---

## 4. OMM 仓库已有的相关机制（仅陈述事实，不构成建议）

> ⚠️ 本节不构成"启示"或"建议"，仅陈述 OMM 仓库的**事实**，供后续独立产品决策参考。所有源码引用已经主 agent 独立 Read 核实。

### 4.1 OMM 已实现 compaction 应对的"第三法"

`packages/autopilot/src/continuation-engine.ts:116-126` 的 `buildFailureBlock` 函数：当上次 evidence gate 失败时，把失败命令的 stderr 摘要**重新注入下一次 retry 指令**。函数注释（`continuation-engine.ts:116-119`）明确写出动机：

> *"This is most valuable after compaction may have evicted the original tool stderr from the context window."*

安全注释（`continuation-engine.ts:154`）进一步明确消费者模型：

> *"the model is the consumer, not an executor of this text"*

这是一种 **surgical re-injection of decision-relevant detail after compaction** —— 不属于 §2 任何一类（不是 compaction 本身，不是 subagent 隔离，不是 Reflexion 式反思），是 OMM 在 compaction 之外**额外加的一道决策相关细节保护**。

### 4.2 OMM 的 refute-gate 是 Reflexion 的更贴近对应物（非 TodoWrite）

`packages/dynamic-workflows/skill/references/role-prompts/skeptic.md` 定义了一个专门的 skeptic 角色，prompt 原文：

> *"You are a skeptic. Your job is to REFUTE the finding, not confirm it. Default to refuted; only let a finding survive if the evidence is strong and you cannot construct a plausible innocent explanation."*

这是**跨 agent（inter-agent）的对抗式纠错**，比 Claude Code TodoWrite 更贴近 Reflexion 的失败-反思-重试循环。但有一个关键 twist 必须保留：

- **Reflexion**：intra-agent，同一个 agent 跨 trial 自我反思
- **OMM skeptic**：inter-agent，专门一个独立 skeptic agent（推荐用 opus 模型），与 finder/verifier 配对

两者机制不完全等价，只共享"对抗式纠错"这一核心思想。`skeptic.md:28` 自陈 *"no direct OMC equivalent"* —— 这是 OMM 的自定义角色。

### 4.3 OMM 的 7 态 reducer ≠ 研究文献的 "explicit state tracking"

对抗 review（Critic 3）抓到一个范畴错误，主 agent 核实源码后确认：

- **OMM 的 `OrchestrationState`**（`packages/autopilot/src/types.ts:17-24`）是**控制流 FSM**：`unclaimed | claimed | running | retry_queued | released | blocked | done` —— 回答"我在哪个编排阶段"
- **研究文献的 "explicit state tracking"** 指 Generative Agents / MemGPT / LangGraph 那种**持久化、可查询的推理历史**

两者只在 "state" 这个词上重合，能力完全不同。把 OMM 的 FSM 描述为"已在 explicit-state-tracking 族"是奉承项目而非描述项目。

### 4.4 OMM 的 evidence-gate 是 CI 式 pass/fail，非 Reflexion 式自反思

`packages/autopilot/src/evidence-gate.ts:23-95` 的 `evaluateEvidence` 是**同步纯函数**，只判定 validation command 的 pass/fail/timeout/skipped 状态，**无模型调用**。

[ADR-019](../adr/019-conditional-evidence-judging-boundary.md) D2 明确："autopilot keeps a rule-level Evidence Gate; **in-loop model-level judging is deferred, not forbidden**"，并给出明确的 exit condition（任一触发即应起 follow-up ADR）。这是**有意识的产品范围决策**，不是架构禁止。

---

## 5. 反模式警告（精简，3 条）

1. **compaction 不防 goal drift**（本笔记作者的诠释性推论，无单一一手源直接支持）—— 一个 agent 可以忠实地带着压缩 context 继续偏离原目标。缓解：配合显式 todo 跟踪 + 原始意图定期 re-grounding。
2. **self-review rubber-stamp** —— 模型评审自己的输出倾向于确认先验。Reflexion 用**外部信号**（env reward / error）缓解；纯 "review your own work" 提示是最弱形式。更强的形式是用**不同模型**做 review pass（verifier 模式）。
3. **multi-agent token 爆炸** —— Anthropic 自己的数字：15x token 成本。Cognition 的反方立场（含后续部分撤回）说明这不适用于所有任务类型。

---

## 6. Open Questions（全问句，不构成建议）

- OMM 的 7 态编排 FSM 是否应被描述为 "explicit state tracking"？还是该术语暗示一种 OMM 当前没有的 memory / reasoning-history 能力？
- OMM 的 surgical re-injection（`continuation-engine.ts:116-126`）是否值得**显式命名**并在某个 ADR 中记录为一种 compaction 应对策略？目前它只是 Enhancement B 的实现细节，未被抽象命名。
- 是否需要 peer-product（Cursor / Cline / Aider）的更深入对比？本笔记仅做概览。
- 是否引入更广义的 recap-like 能力（面向人或面向模型的跨 session 摘要）？这是 OMM 的产品决策，超出本笔记范围，本笔记不下任何结论。

---

## Sources（完整 URL，访问日期 2026-07-21）

**Anthropic 工程博客（一手）：**
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) —— compaction 逐字原话出处
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) —— +90.2% / 15x / subagent compression 原话出处
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) —— workflows vs agents 区分，evaluator-optimizer 模式

**Claude 官方文档（一手）：**
- [code.claude.com/docs/en/commands](https://code.claude.com/docs/en/commands) —— `/recap`、`/compact`、`/clear`、`/context` 命令清单
- [code.claude.com/docs/en/context-window](https://code.claude.com/docs/en/context-window) —— auto-compact 行为
- [platform.claude.com/docs/en/build-with-claude/compaction](https://platform.claude.com/docs/en/build-with-claude/compaction) —— `<summary>` re-feed 机制
- [platform.claude.com/docs/en/build-with-claude/context-editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) —— microcompaction / tool-result clearing

**Claude Code GitHub（一手）：**
- [Issue #48084](https://github.com/anthropics/claude-code/issues/48084) —— `/recap` command + away-summary controls 文档缺失
- [Issue #48863](https://github.com/anthropics/claude-code/issues/48863) —— recap telemetry-disabled 行为 + opt-out 文档缺失
- [Issue #50137](https://github.com/anthropics/claude-code/issues/50137) —— recap auto-trigger + draft-input 行为文档缺失
- [CHANGELOG.md raw](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) —— 版本号映射（2.1.108 / 2.1.110 / 2.1.113 / head 2.1.215）

**arXiv（一手原始论文，Critic 2 核实 ID）：**
- Reflexion —— [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)，Shinn et al., NeurIPS 2023
- Lost in the Middle —— [arXiv:2307.03172](https://arxiv.org/abs/2307.03172)，Liu et al., 2023
- ReWOO —— [arXiv:2305.18323](https://arxiv.org/abs/2305.18323)，Xu et al., 2023（**R**easoning **W**ith**out** **O**bservation）
- ReadAgent —— [arXiv:2402.09727](https://arxiv.org/abs/2402.09727)，Lee et al., 2024

**业界 vendor（一手）：**
- Aider repo map —— [aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html)
- Cline Plan/Act —— [docs.cline.bot/core-workflows/plan-and-act](https://docs.cline.bot/core-workflows/plan-and-act)
- Cognition "don't build multi-agents" —— [cognition.com/blog/dont-build-multi-agents](https://cognition.com/blog/dont-build-multi-agents)（2025-06-12，后发部分撤回）

**OMM 仓库内部（file:line）：**
- `packages/autopilot/src/types.ts:17-24` —— `OrchestrationState` 7 态
- `packages/autopilot/src/continuation-engine.ts:116-126, 154` —— `buildFailureBlock` surgical re-injection + consumer 注释
- `packages/autopilot/src/evidence-gate.ts:23-95` —— `evaluateEvidence` 纯函数
- `packages/dynamic-workflows/skill/references/role-prompts/skeptic.md` —— refute-gate skeptic 角色
- `docs/adr/019-conditional-evidence-judging-boundary.md` —— D2 model-level judging deferred, not forbidden

---

## UNCONFIRMED 寄存器（Critic 2 要求保留，不漂移成断言）

以下项未能从官方一手来源独立核验，仅基于 GitHub issue / changelog / 业界传闻。**禁止**在后续引用中升级为断言：

| 项 | 状态 | 说明 |
|---|---|---|
| `src/services/awaySummary.ts` 内部文件路径 | UNVERIFIABLE | Claude Code 闭源/混淆，无法核验 |
| ~3 分钟 away 自动触发阈值 | UNCONFIRMED | 官方文档未给具体数字 |
| ~20,000 token compaction/recap 预算 | APPROXIMATE | 业界流传，未核验 |
| auto-compact ~95% 阈值 | UNCONFIRMED | issue #15719 / #18360 提及，非官方文档明示 |
| "hardcoded 不可配置" | UNCONFIRMED | 同上 |
| Lost in the Middle ~5,287 引用数 | MOVING TARGET | Google Scholar 滚动值，若引用须注日期 |

---

## 附：方法说明（本笔记的对抗 review 过程）

本笔记的 v1 草稿经过 4 人对抗 review team 独立审查，各 critic 带明确攻击视角：

| Critic | 视角 | 判决 | 主要贡献 |
|---|---|---|---|
| 1 Scope & Intent | 计划是否偏离用户原意 | PARTIALLY ALIGNED | 砍掉 §6 "OMM 启示"（用户没问 OMM）、§3 7 类图谱缩到 3 个、把 `/recap` vs compaction 提到开篇 |
| 2 Source Integrity | 引用真实性、反 fabrication | TRUSTWORTHY WITH CAVEATS | 独立 WebFetch 核实绝大部分引用；抓到 Anthropic 多 agent 原话被误标"逐字"、CHANGELOG 版本号映射错；强制保留 UNCONFIRMED 寄存器 |
| 3 Synthesis & Overreach | 综合质量、过度类比 | OVERREACHING | 实读 OMM 源码打脸"7 态 = explicit state tracking"；砍掉 TodoWrite↔Reflexion 等不可辩护映射；发现 surgical re-injection 与 refute-gate 是被漏掉的真正原创点 |
| 4 Repo Conventions | 落盘位置/格式合规 | PARTIALLY COMPLIANT | 改 `状态` 值为 `Analysis（非 Design、非 ADR）`；文件名加 topic 锚点；否定式位置论据 |

本笔记的最终结构是 4 份批评综合后的产物。研究本身可信（引用经独立核实），但 v1 的结构、综合、命名、状态值都有实质缺陷，v2 已修正。
