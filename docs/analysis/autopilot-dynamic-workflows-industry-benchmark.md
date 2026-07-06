# Autopilot × Dynamic-Workflows：业界范式对标分析

> **类型**：非约束性分析报告（Non-binding analysis）
> **日期**：2026-07-06
> **状态**：Analysis（非 Design、非 ADR）
> **方法**：deep-interview 5 轮收敛 + 3 个 Explore agent 代码/文档核实 + 2026 业界现状补足
> **范围声明**：本报告评估 OMM"互补共存、宿主中介"立场在业界编排范式下是否稳健、是否需要演进。**不产出代码、不推翻现有 ADR、不重提"是否应联合"（`CONTEXT.md:61` 已答）、不做竞争排名。**

---

## 0. 阅读指南

- 报告内"能力"指主锥（能力完备性），"安全"指制衡锥（安全/可控性）。
- 凡引用项目内文件均标 `file:line`，凡引用业界均附 URL；截至 2026-07-06。
- 本报告**延伸**而非替代 [`docs/design/autopilot-dynamic-workflows-boundary.md`](../design/autopilot-dynamic-workflows-boundary.md) §6 的"业界最佳实践映射表"。boundary doc §6 已覆盖**微内核范式**（K8s controller / VSCode ext host / Envoy filter chain / CQRS projection）；本报告的增量价值在**编排框架范式**（Temporal / LangGraph / AutoGen 家族）+ **能力完备性锥子**——这是 boundary doc 刻意未做的维度。

---

## 1. 执行摘要

**一句话结论**：OMM 让 autopilot 与 dynamic-workflows "互补共存、宿主中介、插件间零 import" 的立场，在业界编排范式对标下**总体稳健**——它精准地选择了"微内核 + 安全内核收敛 + 可插拔运行时（OpenProse）"这条与 Temporal/LangGraph/AutoGen 都不同的第四条路，并在安全锥上**优于**纯能力导向的编排框架；唯一的能力短板集中在"嵌套场景的可观测性"（half-merge 双轨带来的视野盲区），且这个短板 OMM 自己的文档已经定位并给出了**低风险演进方向**（显式化隐式契约），**不需要**重构边界或推翻任何 ADR。

**三行核心判断**：

| 维度 | 判断 |
|------|------|
| 稳健性 | ✅ 稳健。架构选择与业界主流微内核范式一致，且在安全轴上有独特权衡价值 |
| 演进必要度 | 🟡 低。唯一必要演进是"显式化隐式契约"（boundary doc §5.1 已列），属低风险增量 |
| 独特权衡价值 | ✅ 高。"资源轴上卷、安全轴隔离"的 half-merge 双轨在业界框架中没有直接等价物，是面向"不可信子代理"场景的有意取舍 |

---

## 2. OMM 现状定位（证据 grounded）

### 2.1 三模块定位表

| 模块 | 本质 | 职责轴 | 语义 | 关键证据 |
|------|------|--------|------|----------|
| **autopilot** v3.0.3 | OpenClaw 插件（纯 7 态 reducer 的连续执行循环）| **持续 / 跨轮** | allow-by-default 父循环 | `CONTEXT.md:9,19`；`architecture.md:36-51`；`packages/autopilot/index.ts`（`register()` at `:457`） |
| **dynamic-workflows** v0.1.3 | 名字误导——**不是引擎**：① priority-11 `before_tool_call` fail-closed 守卫 ② 只读 projection 层 ③ 教 agent 写 `.prose` 的 skill | **并行 / 扇出** | fail-closed 子会话守卫 | `CONTEXT.md:10,52`；`architecture.md:53-59`；`packages/dynamic-workflows/index.ts:1-12,71` |
| **permission-policy** v0.1.2 | 纯库（共享权限原语）| 两者共同内核 | —— | `CONTEXT.md:11,43`；`architecture.md:62-65` |

### 2.2 关键架构决策清单（红线与裁决）

| # | 决策 | 出处 | 性质 |
|---|------|------|------|
| D1 | "Workflows 负责并行，Autopilot 负责持续：互补能力，不互相替代" | `CONTEXT.md:61` | 设计原则（红线） |
| D2 | 任何"让 autopilot 问一下 DW"的需求，必须经 host event 或 permission-policy 传递，**绝不建立插件间 import** | `boundary.md:44`（§2.2） | 红线 |
| D3 | 否决把 dynamic-workflows 变成"中央 workflow controller"，产品边界定为 observability/projection | `ADR-014`（Decision 段 + Non-Decisions 段） | 已 Accepted |
| D4 | workflow 引擎是宿主 OpenProse，不是 omm；omm 不重建 scheduling/recursion/branching | `ADR-009`（Decision）；`ADR-014` Rationale #1 | 已 Accepted |
| D5 | half-merge 双轨：资源轴（token/model）上卷父 run，安全/生命周期轴（权限/审计/编排/续跑）留 DW——**不是 bug，是双轨语义** | `boundary.md:98-102`（§4.2） | 设计裁决 |
| D6 | 子代理被视作不可信，跑在 fail-closed 默认下 | `architecture.md:86-93` | 安全模型 |
| D7 | hook priority 11/10/9 是唯一公认的隐式耦合，无单一真相源 | `boundary.md:67`（DEC-5）；§5.1 列为"应做" | 待显式化 |

---

## 3. 业界范式对标（四大类）

每个框架：一句话范式 → 核心机制 → 与 OMM 哪个张力最相关。

### 3.1 Temporal（长程 + 崩溃恢复的黄金标准）

- **范式**：durable workflow orchestration。Workflow = 用代码写的确定性编排逻辑，Activity = 一次工作单元，全部状态由平台 event sourcing 持久化，崩溃后基于事件历史 **replay** 重建。
- **核心机制**：
  - **Child Workflow**：从父 workflow 内 spawn 的独立 workflow，有**独立 event history**、独立 replay，由 **Parent Close Policy** 决定父结束时子的命运（terminate / abandon / request-cancel）。（[Temporal Child Workflows 官方文档](https://docs.temporal.io/child-workflows)）
  - **Checkpoint = 每一步**：每个 workflow task 完成都持久化，本质上是连续 checkpoint，不是周期性快照。
  - **资源与生命周期统一上卷**：父可见子的执行状态；父可 `await` 子结果；子的失败可冒泡触发父的重试/补偿。
- **与 OMM 最相关的张力**：**张力 1**（half-merge 双轨 vs Temporal 统一上卷）。Temporal 让资源**和**生命周期都关联到父；OMM 刻意只关联资源轴。这是全报告最锋利的对照。

### 3.2 LangGraph（循环可图化 + 人机中断）

- **范式**：把 agent 流程显式建模为**状态图**（node = 计算/动作，edge = 路由），由 checkpointer 持久化图状态。
- **核心机制**：
  - **Planner-Executor / ReAct**：典型建模为 `plan → execute → replan` 节点链，或工具调用 ReAct 循环。
  - **Interrupt**：`interrupt()` 函数或编译期 `interrupt_before/after` 在指定节点暂停，等人类批准/编辑后从 checkpoint resume。（[LangGraph HITL 官方文档](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)）
  - **Checkpointer**：`MemorySaver` / `SqliteSaver` / `PostgresSaver` 持久化图状态以支持 resume。
- **与 OMM 最相关的张力**：**张力 2**（autopilot 7 态 reducer 循环 vs LangGraph 显式图）。autopilot 的 `continuation-engine`（`decideContinuation`）+ `evidence-gate` 是近同构体，但 OMM 用"循环 + 派生状态"而非"显式图 + 持久化节点"。

### 3.3 AutoGen GroupChat / CrewAI Crew / OpenAI Swarm（多 agent 群聊与 handoff）

- **范式**：多 agent 角色（planner / researcher / coder / critic）通过群聊或显式 handoff 协作，由 group-chat manager 或 crew orchestrator 路由消息。
- **核心机制**：
  - **GroupChat**：manager agent 决定下一个发言者（auto / manual / round-robin / LLM-routed）。
  - **Handoff**（Swarm）：agent 把对话权 + 上下文交给另一个 agent。
  - **角色定义**：每个 agent 有 system prompt、tool 集、described role。
- **与 OMM 最相关的张力**：**张力 3**（DW 是守卫而非 executor vs AutoGen 群聊执行器）。OMM 的 fan-out 执行**外包给 OpenProse**（ADR-009），DW 只负责守卫；AutoGen/CrewAI 把"执行 + 路由"都内建。

### 3.4 产品化 agent（生态参照，次要）

- **范式**：宿主内置编排，subagent 是一等公民。
- **核心机制（2026 现状）**：
  - **Claude Code subagents**：orchestrator-subagent 模型，主会话 spawn 隔离子代理，各带独立 context window，可并行。已成为 2026 主流，VS Code 2026/02 原生支持并行子代理。（[VS Code Multi-Agent 2026/02](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)）
  - **Codex / Devin / Cursor / GitHub Spark**：同属"宿主 + 插件 + 子代理"家族，编排逻辑**内建于宿主**，而非作为可插拔插件链。
- **与 OMM 最相关的张力**：**张力 4**（宿主中介 vs 内置编排）。OMM 把编排能力拆成 3 个独立可发布的 npm 包 + 宿主 OpenProse 引擎；产品化 agent 倾向于把编排**内建**到宿主里。

---

## 4. 双锥评估矩阵（核心）

逐张力点对比。**能力**列 = 能力完备性锥（0-5，越高越完备）；**安全**列 = 安全/可控性锥（0-5，越高越可控）。两者往往此消彼长——OMM 的判断力体现在**知道在哪一极上加码**。

| 张力点 | 业界代表做法 | 能力 | 安全 | OMM 选择了哪一极 | 评注 |
|--------|--------------|------|------|------------------|------|
| **1. 父-子生命周期统一性** | Temporal：父 await 子、父结束 policy 控制子 | 5 | 3 | **安全极**（half-merge：只上卷资源，不接管子生命周期） | Temporal 假设子是可信的确定性代码；OMM 假设子是不可信的 LLM 子代理，**有意不让父循环的 allow-by-default 污染子的安全轴**（`boundary.md:99-102`） |
| **2. 循环 vs 显式图** | LangGraph：plan→execute→replan 显式节点 + interrupt | 4 | 4 | **循环极**（7 态 reducer + continuation-engine，不显式化为图） | autopilot 的循环对"跨轮长程 + 派生状态"够用且更简洁；但缺乏 LangGraph 那种"在任意节点 interrupt + 可视化图"的能力 |
| **3. fan-out 执行位置** | AutoGen/CrewAI：内置 executor + 路由 | 5 | 2 | **外包极**（执行交 OpenProse，DW 只守卫） | 避免重建运行时（ADR-009 E2：8/8 模式 OpenProse 已覆盖）；代价是 DW 不能自主决定路由，依赖宿主 |
| **4. 编排能力归属** | 产品化 agent：内建宿主 | 5 | 2 | **解耦极**（3 个独立可发布包 + 共享内核） | 可独立测试/发布/禁用（boundary doc §6 P-9）；代价是协调全部经 host，显式但有间接成本 |
| **5. 权限决策单点收敛** | 多数框架：散落在各 agent prompt 或无 | —— | 1-2 | **内核极**（permission-policy 单一共享库，ADR-013） | 业界编排框架普遍**缺**这一层；OMM 的独特权衡价值所在 |
| **6. 崩溃恢复** | Temporal：event sourcing 连续 checkpoint + replay | 5 | 4 | **快照极**（autopilot 在稳定转换点写 checkpoint，重启时 re-derive） | 比 Temporal 粗（只在稳定转换点，不是每步），但 ADR-016 sole-writer 不变量保证 `status` 永不从磁盘信任，安全更硬 |
| **7. 嵌套场景可观测性** | Temporal：子 workflow 原生在父 history 可见 | 4 | 3 | **盲区极**（half-merge：orchState/evidence gate 视扇出为黑盒） | **唯一明显能力短板**；但已被 ADR-014 projection 路线 + boundary doc §5 显式化方向覆盖 |

---

## 5. 四个核心张力点深度分析

### 5.1 张力 1：half-merge 双轨 vs Temporal 统一上卷

**对照**：Temporal 的 child workflow 与父**统一治理**——父可 await 子、子的异常冒泡、Parent Close Policy 决定子命运、子状态在父的历史里可追溯（[Temporal docs](https://docs.temporal.io/child-workflows)）。这是"能力完备性"锥下的**满分级**做法。

**OMM 的反方向**（`boundary.md:78-107`）：autopilot 的 8 个 hook 对 subagent **不一致归并**——资源类（`llm_output` token、`before_model_resolve` 模型）上卷，生命周期类（`before_agent_finalize` 续跑、`before_tool_call` 权限、`agent_end` 状态）**不**上卷。净效果：orchState/evidence-gate/continuation-engine 视扇出为**不透明黑盒**。

**双锥裁决**：
- **能力锥**：3/5。父循环看不见子分支进度，evidence gate 在父 workspace 验证最终状态对子结果无感——这限制了"autopilot 智能地等待/重试/补偿特定子分支"的能力。
- **安全锥**：5/5。这是 OMM 最有价值的设计。Temporal 假设子是可信的确定性代码；OMM 假设子是**不可信的、可能被 prompt injection 的 LLM 子代理**（`architecture.md:86-88`）。如果让父循环（allow-by-default）接管子的生命周期，等于让"宽松治理者"渗透进"严格治理域"，违反 fail-closed 原则。**这个 3/5 的能力分换 5/5 的安全分，在 OMM 的威胁模型下是赚的。**
- **稳健性结论**：✅ 稳健。不是能力缺陷，是面向不可信子代理的有意取舍。

### 5.2 张力 2：autopilot 循环 vs LangGraph 显式图

**对照**：LangGraph 把 agent 流程建模为可中断、可 resume、可可视化的**状态图**，interrupt + checkpointer 是一等公民（[LangGraph HITL](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)）。

**OMM 的方向**：autopilot 是纯函数 7 态 reducer（`orchestratorReducer`）+ continuation-engine（`decideContinuation` 返回 `revise`/`cross_turn`/`pause`/`complete`）+ evidence-gate。状态派生而非图建模。

**双锥裁决**：
- **能力锥**：3/5。缺少 LangGraph 的"任意节点 interrupt + 可视化图"能力。pause/resume 存在（`index.ts` gateway RPC `autopilot.pause/.resume`）但不能在任意中间点中断；图不可视化（projection 是状态投影，不是图拓扑）。
- **安全锥**：4/5。纯函数 reducer + sole-writer `status`（ADR-016）+ checkpoint 在稳定转换点写——状态推导可验证，比隐式图状态机更难陷入不一致。
- **稳健性结论**：✅ 基本稳健。循环对"跨轮长程执行"这个目标域**够用且更简单**；显式图的价值在"多分支路由 + 人工中断"，而 OMM 把多分支交给了 dynamic-workflows/OpenProse，分工清晰。LangGraph 的 interrupt 在 OMM 等价物是 evidence-gate 失败后的 `pause` + `retry_queued`，覆盖了主要人机中断场景。

### 5.3 张力 3：DW 守卫 vs AutoGen 群聊执行器

**对照**：AutoGen GroupChat / CrewAI 把"路由决策 + 执行"都内建——manager agent 决定下一个发言者，agent 直接执行工具。

**OMM 的方向**：dynamic-workflows **只守卫、不执行、不路由**。执行外包给宿主 OpenProse（ADR-009），路由由 `.prose` 程序 + OpenProse 解释器决定，DW guard 只对 `:subagent:` 的破坏性 tool call fail-closed。

**双锥裁决**：
- **能力锥**：3/5。DW 不能自主决定"哪个子代理下一步该干什么"——这由 `.prose` 程序（agent 生成）+ OpenProse（宿主解释）决定。灵活性取决于 `.prose` DSL 的表达力（ADR-009 E2：8/8 编排模式覆盖）。
- **安全锥**：5/5。守卫与执行**职责分离**是 OMM 的核心安全贡献——守卫逻辑极简（154 行 `index.ts`），三处 fail-closed（missing sessionKey / classify error / 内部 error），不掺入路由复杂度，攻击面最小。
- **稳健性结论**：✅ 稳健。AutoGen/CrewAI 把执行和路由内建换来能力，但牺牲了"守卫可独立审计 + 可独立发布 + 可被任意宿主复用"。OMM 的拆分让 DW guard 成为**纯安全组件**，这与 ADR-014 的产品边界（observability/projection）完全自洽。

### 5.4 张力 4：宿主中介 vs 产品化 agent 内置编排

**对照**：Claude Code / Codex / Devin / Cursor / GitHub Spark 倾向把编排**内建**进宿主——subagent、orchestrator、工具调用都是宿主原生概念（[VS Code Multi-Agent 2026/02](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)）。

**OMM 的方向**：编排能力拆成 3 个独立可发布的 npm 包（autopilot / dynamic-workflows / permission-policy），通过 OpenClaw host 的 hook 链 + priority chain + session-key 分区涌现协调，**零插件间 import**（`boundary.md:34-44`）。

**双锥裁决**：
- **能力锥**：3/5。协调全部经 host，有间接成本（hook priority 是 magic number、event-shape 是防腐层契约而非强类型集成、INT-8 跨目录审计可见性是已知限制）。
- **安全锥**：5/5。微内核范式的安全红利——任一插件可独立禁用、独立审计、独立回滚；permission-policy 单点收敛避免安全逻辑重复（boundary doc §6 P-1/P-7/P-11）。
- **稳健性结论**：✅ 稳健。这是 boundary doc §6 已充分论证的维度（K8s controller / VSCode ext host / Envoy filter chain），本报告不重复。OMM 在生态定位上**独特**——它是少数把"agent 编排"做成微内核插件链而非宿主内置的项目。

---

## 6. 判断结论

### 6.1 总体判断

OMM 的"互补共存、宿主中介"立场在业界编排范式下**总体稳健**。它没有走 Temporal/LangGraph/AutoGen 任一条路，而是走出**第四条路**：微内核 + 安全内核收敛 + 可插拔运行时（OpenProse）。这条路的代价是**能力上限略低**（尤其在嵌套场景可观测性上），收益是**安全下限显著更高**。在 OMM 的威胁模型（子代理不可信、可能被 prompt injection）下，这个取舍是**对齐的**。

### 6.2 逐张力点"是否需要演进"

| 张力点 | 稳健？ | 需要演进？ | 演进性质 |
|--------|--------|-----------|----------|
| 1. half-merge 双轨 | ✅ | 🟡 低——仅可观测性维度 | 低风险（显式化，见附录 A） |
| 2. 循环 vs 显式图 | ✅ | ❌ 否 | —— |
| 3. DW 守卫 vs 执行器 | ✅ | ❌ 否 | —— |
| 4. 宿主中介 vs 内置 | ✅ | 🟡 低——仅隐式契约 | 低风险（显式化，见附录 A） |
| 5. 权限单点收敛 | ✅ | ❌ 否（独特权衡价值） | —— |
| 6. 崩溃恢复 | ✅ | ❌ 否 | —— |
| 7. 嵌套可观测性 | 🟡 | ✅ 是（已规划） | 中风险（ADR-014 projection Milestone D） |

### 6.3 何时这套架构会**不再**稳健（边界条件）

为负责任地给出结论，明确这套架构的**失效边界**：

1. **若子代理变为可信**（如纯确定性代码 agent），half-merge 双轨的安全收益消失，能力短板凸显——此时 Temporal 式统一上卷会更优。但 OMM 的 LLM 子代理场景不满足此前提。
2. **若宿主 OpenProse 不再演进**，OMM 的 fan-out 能力被宿主天花板锁死——此时需要重新评估"是否自建执行器"（违反 ADR-009，但属于战略级重评，超出本报告范围）。
3. **若嵌套场景成为主流使用模式**，可观测性盲区（张力 1/7）会从"已知限制"升级为"产品阻塞"——此时 ADR-014 projection 路线必须加速落地。

---

## 7. 附录

### 附录 A：低风险演进机会（boundary doc §5 已列，本报告仅汇编）

以下均为 boundary doc 自己列出的"显式化隐式契约"方向，**与现有 ADR 不冲突**，属本报告 Non-goals 守护下的可选项（仅记录，不实施）：

| 项 | 出处 | 风险 | 价值 |
|----|------|------|------|
| 导出 `HOOK_PRIORITIES` 单一真相源 | `boundary.md:113-118`（§5.1） | 低 | 消除唯一隐式耦合，加断言测试 |
| DW logger 安全护栏（DEC-2 try/catch） | `boundary.md:120-121`（§5.2） | 低（纯 bug 修复） | 防 guard 内抛误 block 合法子代理 |
| INT-8 跨目录审计可见性（经 projection 而非 autopilot 伸手） | `boundary.md:107`（§4.2） | 中（需 projection 层） | 让 `autopilot.status` 看见子 block |
| INT-3 子模型意图优先（ADR-017 已解决） | `boundary.md:106,127`（§5.4） | —— | 已 Done 2026-07-06 |

**高风险演进**（重构边界 / 推翻 ADR / 插件间 import）一律超出本报告范围，受 Non-goals 约束不予展开。

### 附录 B：框架速查表

| 框架 | 范式 | 长程 | 崩溃恢复 | 扇出 | 人机中断 | 权限单点 | 与 OMM 最近张力 |
|------|------|------|----------|------|----------|----------|-----------------|
| **Temporal** | durable workflow + child workflow | ✅✅ | ✅✅ event sourcing replay | ✅ child workflow | ✅ signal/query | ❌（外挂） | 张力 1 |
| **LangGraph** | 状态图 + interrupt + checkpointer | ✅ | ✅ checkpointer | ✅ 多节点 | ✅✅ interrupt_before/after | ❌（外挂） | 张力 2 |
| **AutoGen/CrewAI/Swarm** | 群聊 + handoff + 角色 | ✅ | 🟡 部分 | ✅✅ 内建 | 🟡 | ❌（外挂） | 张力 3 |
| **Claude Code/Codex/Devin/Cursor** | 宿主内置编排 + subagent | ✅ | 🟡 宿主依赖 | ✅ subagent | 🟡 | ❌（宿主内） | 张力 4 |
| **OMM** | 微内核插件链 + 共享安全内核 + 外挂运行时 | ✅ | ✅ 稳定转换点 checkpoint | ✅ OpenProse | ✅ evidence-gate→pause | ✅✅ permission-policy | 全部（独特权衡） |

### 附录 C：证据索引

**项目内（file:line，截至 2026-07-06）**：
- `CONTEXT.md:9-11`（三模块协作）、`:61`（互补不替代红线）
- `docs/architecture.md:3-7`（三模块）、`:36-65`（模块职责）、`:86-93`（不可信子代理安全模型）、`:97-107`（Distribution Reality）
- `docs/design/autopilot-dynamic-workflows-boundary.md:10`（一句话结论）、`:44`（红线禁止 import）、`:67`（DEC-5 hook priority 隐式耦合）、`:78-107`（嵌套场景 + half-merge）、`:98-102`（双轨设计裁决）、`:113-151`（action items）
- `docs/adr/009-dynamic-workflows-via-openprose.md`（Decision 段：不建运行时）
- `docs/adr/014-dynamic-workflows-product-boundary.md`（Decision + Non-Decisions：否决 controller、定为 observability）
- `packages/dynamic-workflows/index.ts:1-12`（guard 定位 docstring）、`:71`（register）
- `packages/autopilot/index.ts:457`（register entry）

**业界（URL）**：
- Temporal Child Workflows — https://docs.temporal.io/child-workflows
- LangGraph Human-in-the-loop — https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- VS Code Multi-Agent Development (2026/02) — https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development
- Claude Code orchestration (2026) — https://www.augmentedswe.com/p/claude-code-orchestration

---

> **报告自检**：✅ 无代码改动 / ✅ 无 ADR 草案 / ✅ 无"是否联合"重提 / ✅ 无竞争排名（appendix B 是能力对照表，非优劣排名）/ ✅ 每个张力点双锥均评分 / ✅ 所有引用含 `file:line` 或 URL。
