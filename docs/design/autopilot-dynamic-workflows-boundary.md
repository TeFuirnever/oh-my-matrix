# Autopilot ↔ Dynamic-Workflows 边界与集成设计

> 状态：Design | 2026-07-02
> 方法：3 个 opus scientist agent（integration-truth / decoupling-quality / industry-practices）交叉验证 + 综合。
> 关联：[architecture.md](../architecture.md)、[ADR-013 permission-policy-library](../adr/013-permission-policy-library.md)、[ADR-014 dynamic-workflows-product-boundary](../adr/014-dynamic-workflows-product-boundary.md)。
> 目的：把散在代码注释里的模块边界、协调契约、隐性耦合升格为**单一真相源**，支撑后续演化不撕裂。

## 0. 一句话结论

omm 的三模块架构**已经踩在业界主流微内核范式上**（host-mediated 协调、零插件互依赖、单一共享内核库、priority-ordered filter chain、session-key scope 分区、event-shape 契约测试）。当前**唯一的隐式耦合**是 hook priority（11/10/9）没有单一真相源；此外有 1 个真 bug（DW logger 可抛进 guard）和 3 处需文档化的"隐性穿透耦合"（都来自 autopilot 单向对 subagent 的部分归并）。**增量目标只有一个方向：把隐式契约显式化，而非重构边界。**

---

## 1. 三模块职责边界（解耦：什么各管各）

| 模块 | 形态 | 拥有（single responsibility） | **不碰**（交给谁） |
|------|------|------------------------------|-------------------|
| `@oh-my-matrix/permission-policy` | 纯库 | destructive-op 分类的单一真相源 + audit schema/持久化 + shell tokenizer + 共享数据类型 | 无 hooks、无 plugin manifest、不 import openclaw runtime、不懂 session-key 约定、不懂 workflow/continuation 语义 |
| `@oh-my-matrix/autopilot` | plugin | continuation 控制回路（stall/completion 检测、evidence gate、retry queue、goal manager、model-routing、run-scoped guard） | 不做 subagent 安全 guard（→DW）、不做 workflow 编排（→OpenProse）、不自实现权限分类（→permission-policy） |
| `dynamic-workflows`（两个表面，ADR-014） | skill + guard plugin | (1) authoring skill：判断是否上 workflow 规模、生成 `.prose`、记 metadata；(2) runtime guard：对 `:subagent:` 调用 fail-closed 阻断 + audit append | guard 不做 planning/execution/UI；skill 不自建 runtime（→OpenProse，ADR-009）；两者都不实现权限分类 |
| （新）host/UI projection | 只读投影 | ADR-014 的 `DynamicWorkflowProjection`，从 OpenProse run state + audit + metadata 派生 read model | 只读，不 mutate runtime、不 filesystem discovery、不长成 controller |

**判据（何物归何处）**：看"因什么原因而变"。permission-policy 因"什么算 destructive"而变；session-key 解析因"OpenClaw 命名约定"而变——不同变因 → 不同归属，不强行合并（P-8 AHA / Sandi Metz "wrong abstraction"）。

---

## 2. 集成契约（共享什么 + 如何协调）

### 2.1 唯一共享代码 = permission-policy（shared kernel）
- 两插件都以 `peerDependencies: ^0.1.1` 消费（peerDep 而非 dep = host 装一份、共享同一实例 = one-version rule 收敛 diamond 依赖）。
- 唯一入口 `decidePermissionForEvent`（ADR-013 规定 guards MUST call this）→ 两个消费者用法一致，不是各拿零件。
- **红线**：守住"只此一个共享库"。抽第二个共享库前必须过 Rule-of-Three（≥3 消费者 + 契约已稳定，P-7）。

### 2.2 协调是 host-mediated，插件间零直接调用（K8s controller 范式）
三个 `before_tool_call` handler 经**优先级链 + session-key 分区**协调，彼此**永不 import**：

```
tool call ──► DW guard (pri 11, 只管 :subagent:, block 短路)
           ──► autopilot (pri 10, 只管自己的 run)
           ──► matrixassistant-audit (pri 9, 记录)
```

- **为什么零互依赖**：K8s Deployment controller 不认识 ReplicaSet controller，只在 shared API server 上读写对象。omm 同理——协调经 host event + 共享 permission-policy 库**涌现**，不产生 N² 耦合。
- **红线**：任何"让 autopilot 问一下 DW"的需求，改写成经 host event 或经 permission-policy 传递，绝不建立插件间 import。

### 2.3 session-key 分区是协调不打架的根本（P-5）
- DW guard 只对 `sessionKey.includes(':subagent:')` 动手；autopilot run-scoped handler 只管自己 keyed 到主 session 的 run；main session call 走默认审批。
- 同一 `before_tool_call` 事件上，**按 session 类型天然互斥**（INT-5）：subagent call 只有 DW 起作用、autopilot 空转（`findRunBySession(subagentKey)` → undefined → no-op）；主 session call 反之。priority 11>10 只是 belt-and-suspenders。

### 2.4 Seam 契约 = event-shape.contract + fixtures（P-10/P-11）
- `event-shape.contract.ts`（两包各一份）是 omm↔OpenClaw 的 consumer-driven contract + 防腐层：OpenClaw 改事件形状 → build 独立报错。
- `extractCommandSegments(event)` 是唯一的字段访问 adapter——业务代码不裸摸 `event.params.*`。
- **安全边界不可精简**：DW guard 三处 fail-closed（missing sessionKey / classify error / 内部 error 一律 block）是 trust boundary，永不因简化删除（2026-06-28 silent fail-open placebo bug 的教训）。

---

## 3. 隐性耦合点审计（含裁决）

3 个 agent 挖出的全部实际跨模块交互点。**"正确隔离"保持不动；"意外耦合"按裁决处置。**

| # | 交互点 | 性质 | 裁决 |
|---|--------|------|------|
| INT-5 | `before_tool_call` pri 11 vs 10：按 session 类型互斥 | ✅ 正确隔离 | 保持 |
| DEC-1 | permission-policy shared kernel 边界干净 | ✅ 正确抽取 | 保持 |
| DEC-3 | `event-shape.contract.ts` 逐字节镜像 | ✅ 受控重复（需 openclaw 依赖，独立 build-canary 是特性） | 保持；**可选**：两包复用同一份 fixture 消漂移 |
| DEC-4 | audit-entry：类型共享、构造分开（语义不同） | ✅ 类型是正确的缝 | 保持 |
| **DEC-5 / P-7** | **hook priority 11/10/9 无单一真相源**（11 是 magic number，10/9 只活注释） | ⚠️ **唯一公认隐式耦合** | **§5.1 升格为单一真相源 + 断言测试** |
| **DEC-2** | **DW logger `emitJson` 缺 try/catch**（autopilot 版有）→ guard 内可抛 → 误 block 合法 subagent | 🐛 **真 bug** | **§5.2 补安全护栏** |
| INT-1 | `:subagent:` 识别两包各自 inline（漂移风险） | ⚠️ 意外耦合 | §5.3 文档化为共享约定；Rule-of-Three 前不抽 |
| INT-2 | subagent token 计入 autopilot 父 budget（可 pause 父 run） | ⚠️ 隐性穿透（对所有 subagent 有意，对 workflow 分支顺带） | §4 文档化为"资源归并"双轨语义 |
| INT-3 | subagent 模型被父 routing `subagentTier` 改写 | ⚠️ 潜在配置冲突（子模型意图可能被父覆盖） | §4 需决策：子 WORKFLOW.md 模型 vs 父 subagentTier 优先级 |
| INT-4 | **"半归并"subagent**：token/model 归并、权限/审计/编排/续跑**不**归并 | ⚠️ 结构 gap（资源上算你的，治理上不算你的） | §4 明确双轨设计意图 + 守护红线 |
| INT-8 | 共享 audit sink `.autopilot/audit-*.jsonl`：条件混流 + 完整度不对称 | ⚠️ 意外耦合 | §4 文档化；`autopilot.status` 读不全子 block 是已知限制 |
| INT-9 | DW projection 读共享 `PermissionAuditEntry`（未接线，ADR-014 gated） | ⚠️ WIP gap | 保持 gated；接线时即成正式只读集成 seam |

---

## 4. 嵌套/共存场景设计（填补核心 gap）

**场景**：一个 autopilot run 内，主 agent 决定用 dynamic-workflows 扇出 → OpenProse spawn `agent:main:subagent:branch-N`。这是之前**任何文档都没覆盖**的交互。实测行为如下：

### 4.1 当前实际行为（integration-truth 实测）
autopilot 的 8 个 hook 对 subagent **不一致归并**——**资源类归并，生命周期类不归并**：

| autopilot hook | 解析父 session？ | 对 workflow-subagent 的效果 |
|----------------|-----------------|---------------------------|
| `llm_output`（token） | ✅ | 子 token 计入父 budget，能 pause 父 run |
| `before_model_resolve`（模型） | ✅ | 子模型被父 `subagentTier` 改写 |
| `before_agent_finalize`（续跑） | ❌ | 不对子续跑（子 key 找不到 run → `continue`） |
| `before_tool_call`（权限+审计） | ❌ | 子 tool call 对 autopilot 不可见（交 DW guard） |
| `before_agent_run`（excludedAgents） | ❌ | 依赖 host 传哪个 key（未文档化控制面） |
| `after_tool_call`（错误计数） | ❌ | 子 tool error 不计父 |
| `agent_turn_prepare`（orchState） | ❌ | 子 turn 不推父 orchState |
| `agent_end`（orchState） | ❌ | 子结束不动父 orchState |

**净效果**：orchState / evidence gate / continuation engine 视扇出为**不透明黑盒**——父 run 停在 `running`，把整个扇出当一次长 turn；evidence gate 在**父** workspace 验证最终状态，对子结果无感。**唯一真穿透的是 token**（+ 副作用：子 LLM 输出会给父 stall 计时器保活）。

### 4.2 设计裁决：这是"资源治理归父、安全治理归 DW"的**双轨设计**
半归并**不是 bug，是双轨语义**，但必须显式声明并守护：

- **资源轴（归父，有意）**：token 归并防止一次大扇出绕过 autopilot 的 `tokenBudget` 无限烧钱。这是**期望行为**——autopilot 作为 run 的资源治理者，必须看见其 session 树下的总消耗。
- **安全/生命周期轴（归 DW / 不归父，有意）**：subagent 的权限、审计、编排由 DW guard + OpenProse 负责，autopilot **不**接管（符合 ADR-014：autopilot 不做 subagent 安全 guard）。

**守护红线**：
1. **一致性**：未来任何"让 autopilot 感知 subagent"的改动（如审计 subagent、evidence gate 感知扇出）必须先明确落在哪条轴，不得再制造第三种半归并。
2. **INT-3 需修正**：模型解析用**父** `state.workflow.modelRouting` 覆盖子模型，会吞掉子 WORKFLOW.md 的模型意图。裁决：**子自身模型意图优先**——`before_model_resolve` 对 subagent 应先看子 session 是否有独立配置，无才 fallback 父 `subagentTier`。（列为 §5.4 action item，需确认 host 是否传递子配置。）
3. **INT-8 已知限制**：`autopilot.status` 用 `loadRecentAuditEntries(父 workspace)` 读不到写在子 cwd 的子 block audit。文档化为已知限制；若要 status 显示子 block，需 projection 层（ADR-014）统一读，而非 autopilot 伸手读子目录。

---

## 5. Action Items（按性价比排序）

### 5.1 【应做·消除唯一隐式耦合】hook priority 单一真相源
把 11/10/9 从"两个文件的 magic number + 注释"升格为**被测试守护的契约**：
- 在 `permission-policy` 导出 `HOOK_PRIORITIES = { subagentGuard: 11, autopilotRunScoped: 10, audit: 9 }`（audit priority 本就与 permission-policy 的 audit 职责同域，归属合理）。
- autopilot / DW 从此常量读，不再各写裸 int。
- permission-policy 加断言测试：`subagentGuard > autopilotRunScoped > audit`。
- **保持零互依赖**：两插件仍只依赖 permission-policy，不互相 import。

### 5.2 【应做·真 bug】DW logger 安全护栏（DEC-2）
`dynamic-workflows/src/logger.ts` 的 `emitJson` 补 autopilot 版已有的 try/catch（围 `JSON.stringify`，防循环引用/BigInt 抛进 guard）+ `splitArgs`（对象结构进 ctx，非 `[object Object]`）。最小 diff 止血；长期可抽 `createLogger(envPrefix)` 共享工厂（但**不**放 permission-policy——logger 非权限原语，会污染安全 kernel 职责）。

### 5.3 【可选·文档化】`:subagent:` 约定为显式共享契约
两包 inline 的 `isSubagentSession` 靠巧合一致。Rule-of-Three 未到，**不强抽**（它是 host session-key 约定，非权限决策，抽进 permission-policy 会注入 host 知识）。当前动作：在本文档 + 两处代码注释交叉引用同一约定来源，标注"若 OpenClaw 改 key 格式，两包需同步"。

### 5.4 【需确认·潜在 bug】INT-3 子模型意图被父覆盖
确认 host 是否向 `before_model_resolve` 传递 subagent 自身的 workflow 配置；若传递，则 subagent 应优先用自身模型意图，父 `subagentTier` 仅作 fallback。需要 host 语义确认后再改。

### 5.5 【已由 ADR-014 正确 gated】DW projection 只读集成 seam
保持 gated。接线时死守两条红线：projection 只读（不 mutate runtime / 不 filesystem discovery）；不塞无稳定数据源的字段（cost/confidence/recommendation）。这层长成 controller 之日，即微内核架构破功之时（P-12）。

---

## 6. 业界最佳实践映射（omm 已落位 vs 待补）

| 实践 | 参考系统 | omm 状态 |
|------|----------|----------|
| 瘦内核 + 隔离插件（P-1） | VSCode ext host、OSGi | ✅ OpenClaw host + 可禁用插件 |
| 声明式 contribution（P-2） | VSCode contributes | ✅ `openclaw.plugin.json` hooks[]；建议加 manifest↔实现一致性测试 |
| Priority filter chain（P-3） | Envoy、Servlet Filter | ✅ before_tool_call 11>10>9；⚠️ 见 §5.1 |
| Host-mediated 协调（P-4） | K8s controller、Redux | ✅ 零互依赖，经 host + kernel |
| Scope 分区（P-5） | K8s ownerRef、VLAN | ✅ session-key 分区（本文档已显式化） |
| 共享 context 流动（P-6） | ESLint context、Envoy metadata | ✅ (event, ctx) + audit sink |
| Rule-of-Three 共享库（P-7） | Google one-version | ✅ permission-policy；守住只此一个 |
| 容忍受控重复（P-8） | Sandi Metz、AHA | ✅ event-shape/audit 构造/subagent 识别刻意不抽 |
| 独立可测/可发布（P-9） | microservices | ✅ 三包独立 vitest/version/publish |
| Seam 契约测试（P-10） | Pact、snapshot | ✅ event-shape.contract + fixtures |
| 防腐层 + fail-closed（P-11） | DDD ACL、Hexagonal | ✅ extractCommandSegments + guard fail-closed |
| 只读 projection（P-12） | CQRS、K8s status | ✅ ADR-014（gated） |

**一句话理想态**：permission-policy 当决策内核（纯、共享、版本化契约），autopilot 与 DW guard 当两个零互依赖的控制回路（host 经 priority 链 + session-key 分区协调），OpenProse 当 workflow runtime（ADR-009），ADR-014 的 projection 当只读观测 seam。**唯一增量方向：把隐式契约显式化（§5.1 优先），而非重构边界。**
