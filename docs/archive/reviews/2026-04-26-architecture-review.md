# omm v0.2.0 深度架构审视报告

> 🗄 **归档 / Archived** — v0.x OpenClaw 插件/MCP 实现的设计记录。代码已于 0.6.0 移除；本仓库现为文档/设计底座。内部链接可能已失效。

> **审视日期:** 2026-04-26
> **审视范围:** oh-my-matrix (omm) v0.2.0 全量源码 + 设计文档
> **参考基线:** oh-my-codex (omc) v0.14.4 — 48,500 LOC / 532 源文件 / 28 子系统
> **商用就绪评分:** 28/100

---

## 一、概要

oh-my-matrix (omm) 是 MatrixAssistant 的 OpenClaw 插件层，通过 OpenClaw Plugin ABI 为宿主 AI Agent 提供有状态工作流能力（ralph/autopilot/team 三模式状态机）。

**当前规模:** 1,080 LOC 源码 + 336 LOC 测试 = 1,416 LOC，5 tools / 5 skills / 1 MCP server，25 个测试用例。

**核心结论:** omm 架构方向正确（纯插件、零依赖 MCP、状态验证分发器），但存在 1 个 CRITICAL 安全漏洞（path traversal）、1 个 P0 功能缺陷（工作流互斥缺失）、以及大量可移植能力未引入（oh-my-codex 约 15,000 LOC 可移植，omm 当前仅实现 ~7%）。距商用交付需补齐安全修复、工作流互斥守卫、持久化恢复三大基础层，预计新增 ~2,000 LOC。

---

## 二、架构合理性评估

### 2.1 Plugin ABI 设计 — 评分: 6/10 ⚠️

| 维度     | omm 现状                               | omc 参考                                                              | 差距                                     |
| -------- | -------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| 接口定义 | `OmmPluginApi` 全 optional，无版本协商 | `modes/base.ts` 统一生命周期 (`startMode/updateModeState/cancelMode`) | 无能力发现，宿主无法查询插件支持哪些模式 |
| 工具注册 | 5 tools，静态声明                      | 38 skills，动态加载                                                   | 够用但不可扩展                           |
| 钩子系统 | 2 hooks（session start/end）           | 8 文件 hook SDK，keyword triage                                       | 缺少 pre/post tool dispatch 钩子         |

**评判:** `OmmPluginApi` 全 optional 是有意为之——omm 作为 OpenClaw 原生插件，不要求宿主实现任何特定接口。这在单宿主（MatrixAssistant）场景下合理，但未来多宿主接入时需要版本协商机制。

### 2.2 状态验证架构 — 评分: 7/10 ✓

| 维度                            | omm 现状                                                              | 评判                               |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| 单分发器 `validateStateWrite()` | 统一入口，按 mode 分发到 ralph/autopilot/team 验证器                  | ✓ 设计清晰                         |
| 共享终态规则                    | `complete/failed/blocked` 强制 `active=false`，自动注入 `completedAt` | ✓ 防止僵尸工作流                   |
| 默认注入                        | `active=true` 时自动填充缺失计数器和状态                              | ✓ 减少 SKILL.md 模板               |
| 不可变性                        | 验证器工作在 `{ ...candidate }` 浅拷贝上                              | ✓ 不污染输入                       |
| 浅层验证                        | 仅检查字段类型和阶段成员，不检查转换合法性                            | ⚠️ 允许 `init` 直接跳到 `complete` |

**评判:** 验证架构是 omm 设计最好的部分。单分发器 + 共享规则 + 模式特定扩展的三层结构清晰可维护。浅层验证（不检查转换顺序）是有意取舍——由 SKILL.md 指令驱动模型行为，而非硬编码转换图。

### 2.3 双通道访问模型 — 评分: 5/10 ⚠️

| 维度        | 现状                                | 问题                            |
| ----------- | ----------------------------------- | ------------------------------- |
| Plugin 通道 | 完整 `validateStateWrite()`         | —                               |
| MCP 通道    | 内联简化验证（阶段检查 + 终态规则） | 不注入默认值，不验证计数器      |
| 一致性      | 两条路径写同一目录                  | MCP 写入可能创建不完整状态      |
| 并发保护    | tmp+rename 原子写入                 | 不防并发覆盖（last-write-wins） |

**评判:** oh-my-codex 的 MCP state server 使用 per-path serialized async queue（写入队列），omm 没有这个机制。当 plugin 和 MCP server 同时写入同一 key 时，存在竞态条件。当前使用场景（单用户桌面 App）风险较低，但需要文档明确。

### 2.4 Team 委托模式 — 评分: 8/10 ✓

| 维度 | omm 现状                                        | omc 参考                          | 评判               |
| ---- | ----------------------------------------------- | --------------------------------- | ------------------ |
| 架构 | thin bridge，委托宿主的 `TeamCreate/TaskCreate` | 自建 tmux worker 系统（25+ 文件） | ✓ 符合 ADR-002     |
| 隔离 | 依赖宿主提供 worktree                           | tmux + git worktree 手动管理      | ✓ 宿主原生支持更好 |
| 通信 | 通过宿主的消息传递                              | tmux pipe + 37 event types        | ✓ 更简洁           |

**评判:** 这是 omm 最明智的架构决策之一。oh-my-codex 的 team 子系统（25+ 文件）是其最复杂的模块，omm 通过委托宿主避免了整个子系统的实现成本。**ADR-002 的判断完全正确。**

### 2.5 Skills 设计（Model-Driven 状态机）— 评分: 7/10 ✓

| 维度     | 现状                               | 评判                 |
| -------- | ---------------------------------- | -------------------- |
| 驱动模式 | SKILL.md 指令驱动模型执行状态转换  | ✓ 轻量，无运行时开销 |
| 阶段约束 | 仅验证阶段名合法性，不强制转换顺序 | ⚠️ 模型可跳过阶段    |
| 恢复能力 | 无持久化进度，依赖模型上下文       | ⚠️ 跨会话丢失状态    |

**评判:** Model-driven 模式在单会话场景下工作良好，但缺乏 Phase 1 规划的持久化能力。omc 的 ralph 有 progress ledger（进度账本）和 PRD 管理，omm 的 ralph 仅靠模型上下文。

### 2.6 MCP Server 零依赖决策 — 评分: 8/10 ✓

| 维度     | 现状                  | omc 参考     |
| -------- | --------------------- | ------------ |
| 实现     | 手写 JSON-RPC ~260 行 | 使用 SDK     |
| 依赖     | 零运行时依赖          | ~5 个依赖    |
| 维护成本 | 协议变更需手动更新    | SDK 自动跟进 |

**评判:** ADR-003 的零依赖决策对 OpenClaw 插件场景完全合理。~260 行代码可控，且 omm 只用了 tools 能力（不需要 resources/prompts/sampling），维护负担低。

**架构总评: 6.8/10** — 方向正确，核心决策合理，但缺少互斥守卫和持久化两个关键基础设施。

---

## 三、安全审计

### 3.1 CRITICAL: Path Traversal（路径穿越）

**文件:** `omm-packages/omm-plugin/src/omm-tools/omm-state.ts`

State key 无任何清理直接用作文件名：

```
// 当前代码
const filePath = path.join(stateRoot, "state", `${key}.json`);
```

攻击向量：`key = "../../etc/passwd"` 可写出 state 目录。

**修复方案:** 添加 key 清理 — 拒绝包含 `..`、`/`、`\`、null bytes 的 key，并验证解析后的路径仍在 stateRoot 内。

**严重性:** CRITICAL — 可被外部 MCP 客户端利用。

### 3.2 HIGH: 同步 I/O 阻塞事件循环

**文件:** `omm-packages/omm-plugin/src/omm-hooks.ts`

```typescript
writeFileSync(filePath, data, "utf8");
mkdirSync(dir, { recursive: true });
```

`handleSessionEnd` 在 session 结束钩子中使用同步文件 I/O，阻塞 Node.js 事件循环。

**修复方案:** 改为 `fs.promises.writeFile()` + `fs.promises.mkdir()`。

**严重性:** HIGH — 在高并发场景下影响性能。

### 3.3 HIGH: MCP 无认证 + 无协议版本校验

**文件:** `omm-packages/omm-mcp/src/index.ts`

- stdio 信任所有客户端（文档已声明，但实际风险取决于部署环境）
- 客户端发任何 `protocolVersion` 都被接受，不做版本协商

**严重性:** HIGH（取决于部署模型）— 桌面应用场景风险可控，但需文档明确。

### 3.4 MEDIUM: 并发写竞争

**文件:** `omm-tools/omm-state.ts`, `omm-mcp/src/index.ts`

tmp+rename 防止部分写入但不防并发覆盖。当 plugin 和 MCP server 同时写入同一 key 时，last-write-wins。

**修复方案:** 引入 per-path serialized async queue（参考 omc `src/mcp/state-server.ts`）。

**严重性:** MEDIUM — 桌面单用户场景风险低。

### 3.5 MEDIUM: 文件名注入

State key 中的特殊字符（null bytes、Windows 保留名如 CON/PRN/AUX）未处理。

**修复方案:** 与 path traversal 修复合并，添加严格的 key 白名单（`/^[a-z0-9_-]+$/`）。

### 3.6 安全发现汇总

| #   | 发现           | 严重性   | 文件               | 修复成本 |
| --- | -------------- | -------- | ------------------ | -------- |
| 1   | Path traversal | CRITICAL | omm-state.ts       | ~20 LOC  |
| 2   | 同步 I/O 阻塞  | HIGH     | omm-hooks.ts       | ~10 LOC  |
| 3   | MCP 无认证     | HIGH     | omm-mcp/index.ts   | 设计决策 |
| 4   | 并发写竞争     | MEDIUM   | omm-state.ts + MCP | ~40 LOC  |
| 5   | 文件名注入     | MEDIUM   | omm-state.ts       | ~10 LOC  |

---

## 四、代码质量

### 4.1 测试覆盖率

| 模块                    | 测试状态                | 覆盖估算 |
| ----------------------- | ----------------------- | -------- |
| omm-state-validation.ts | ✓ 4 个测试文件，25 用例 | ~80%     |
| omm-tools/omm-state.ts  | ✓ 基本读写测试          | ~60%     |
| omm-tools/omm-ping.ts   | ✓ 基本测试              | ~70%     |
| omm-hooks.ts            | ✗ 零测试                | 0%       |
| omm-config.ts           | ✗ 零测试                | 0%       |
| omm-register.ts         | ✗ 零测试                | 0%       |
| omm-mcp/index.ts        | ✗ 零测试                | 0%       |
| Skills (SKILL.md)       | ✗ 不可测试              | N/A      |

**总体覆盖率估算:** 30-40%。MCP server 是唯一的进程外访问路径，完全零测试。

### 4.2 命名混淆

`omm-state.ts`（smoke record，49 LOC）与 `omm-tools/omm-state.ts`（state CRUD，143 LOC）同名不同用。

**建议:** 重命名 smoke record 文件为 `omm-smoke.ts`。

### 4.3 错误处理

- `handleSessionEnd` 静默吞异常 — `catch (e) { /* ignored */ }` — 会隐藏写入失败
- MCP server 的 catch-all 返回 `-32603 Internal error` — 合理但缺少错误日志

### 4.4 代码复用（重复验证逻辑）

MCP server 内联了 plugin 验证层的简化副本（~50 行）。两个实现独立维护，已出现不一致（MCP 不注入默认值，plugin 注入）。

**建议:** 抽取共享验证模块，MCP server 导入使用。

### 4.5 代码质量汇总

| 维度              | 评分 | 说明                                        |
| ----------------- | ---- | ------------------------------------------- |
| 测试覆盖率        | 4/10 | 30-40%，关键路径（MCP）零覆盖               |
| 命名清晰度        | 6/10 | 一个同名混淆                                |
| 错误处理          | 5/10 | 静默吞异常                                  |
| 代码复用          | 5/10 | 验证逻辑重复                                |
| TypeScript 严格性 | 7/10 | 无 `any`，类型标注基本完整                  |
| Build/lint 合规   | 8/10 | `pnpm build && pnpm test && pnpm lint` 通过 |
| 代码结构          | 7/10 | 文件大小合理（最大 311 LOC）                |
| 可维护性          | 7/10 | 模块边界清晰                                |

**代码质量总评: 6.1/10**

---

## 五、商用交付差距分析

### 5.1 按 P0/P1/P2 分级的差距清单

| #   | 差距                | 优先级 | 预估 LOC | 参考（omc）                          |
| --- | ------------------- | ------ | -------- | ------------------------------------ |
| 1   | Path traversal 修复 | P0     | ~30      | —                                    |
| 2   | 工作流互斥守卫      | P0     | ~200     | `workflow-transition.ts` (251 LOC)   |
| 3   | 统一模式生命周期    | P0     | ~300     | `modes/base.ts` (299 LOC)            |
| 4   | Ralph 持久化/恢复   | P0     | ~400     | `ralph/persistence.ts`               |
| 5   | MCP server 测试     | P0     | ~150     | —                                    |
| 6   | 同步 I/O → 异步     | P0     | ~20      | —                                    |
| 7   | 运行时完成契约      | P1     | ~200     | `run-outcome.ts`                     |
| 8   | Pipeline 阶段定义   | P1     | ~300     | `pipeline/orchestrator.ts` (826 LOC) |
| 9   | 共享验证模块抽取    | P1     | ~50      | —                                    |
| 10  | Memory MCP server   | P2     | ~200     | omc memory MCP                       |
| 11  | Trace MCP server    | P2     | ~200     | omc trace MCP                        |

### 5.2 商用就绪评分

| 维度       | 当前   | Phase 1a 完成后 | Phase 1b 完成后 |
| ---------- | ------ | --------------- | --------------- |
| 安全性     | 30     | 85              | 90              |
| 功能完整性 | 15     | 30              | 55              |
| 测试覆盖率 | 35     | 65              | 75              |
| 文档完整度 | 70     | 75              | 80              |
| 集成完整度 | 25     | 50              | 70              |
| **总分**   | **28** | **~45**         | **~65 (Beta)**  |

---

## 六、与 oh-my-codex 全面能力对比

### 6.1 能力差距总览

oh-my-codex v0.14.4 包含 **28 个子系统**、**38 个 skills**、**5 个 MCP server**、**~30 个 CLI 命令**。omm v0.2.0 覆盖约 **7%** 的可移植能力。

### 6.2 子系统级对比（28 子系统）

#### A. 建议引入（Adopt）— 与 omm 插件定位一致

| 子系统           | omc LOC | omm 状态 | 移植优先级 | 说明                                    |
| ---------------- | ------- | -------- | ---------- | --------------------------------------- |
| 统一模式生命周期 | 299     | 缺失     | P0         | `startMode/updateState/cancelMode` 接口 |
| 工作流互斥守卫   | 251     | 缺失     | P0         | 强制单一活跃模式                        |
| Ralph 持久化     | ~500    | 缺失     | P0         | 进度账本 + PRD 管理                     |
| 运行时完成契约   | ~150    | 缺失     | P1         | `RunOutcome` 类型系统                   |
| Pipeline 编排器  | 826     | 缺失     | P1         | 3 阶段 autopilot                        |
| Ralplan 共识规划 | ~600    | 缺失     | P1         | Planner/Architect/Critic 三方共识       |
| 状态验证（已有） | —       | ✓ 已实现 | —          | omm 实现了 omc 的模式验证层             |
| Agent 角色定义   | ~200    | 缺失     | P1         | 10+ agent 角色提示词                    |
| Hook 可扩展 SDK  | ~400    | 缺失     | P2         | 8 文件 hook 加载/分发框架               |
| Memory MCP       | ~200    | 缺失     | P2         | 持久化 KV 存储                          |
| Trace MCP        | ~200    | 缺失     | P2         | 执行轨迹记录                            |

**小计: ~3,600 LOC 可移植，其中 P0 ~1,050 LOC**

#### B. 建议评估（Consider）— 与宿主能力重叠或需架构调整

| 子系统                  | omc LOC | 评估                  | 说明                         |
| ----------------------- | ------- | --------------------- | ---------------------------- |
| Team 运行时             | ~2,000  | 已用 thin bridge 替代 | ADR-002 决策，不移植         |
| Hook keyword triage     | ~300    | 部分重叠              | 宿主可能有等价机制           |
| 33 个 Agent prompt 文件 | ~3,300  | 按需引入              | 可在 SKILL.md 中内联         |
| Compliance 工具链       | ~200    | 已有                  | omm 自建了 scan-names/verify |
| Wiki MCP                | ~300    | 评估                  | 文档管理，宿主可能覆盖       |
| Cancel/中断处理         | ~400    | 需适配                | omc 的中断语义更丰富         |

#### C. 明确跳过（Skip）— 架构决策排除

| 子系统                   | omc LOC | 跳过原因              | ADR     |
| ------------------------ | ------- | --------------------- | ------- |
| CLI 命令层               | ~2,000  | 纯插件无 CLI          | ADR-001 |
| tmux 管理                | ~800    | 宿主提供 team 原语    | ADR-002 |
| Git worktree 管理        | ~600    | 宿主原生支持          | ADR-002 |
| Rust native crates (5个) | ~5,000  | 插件无需原生模块      | ADR-001 |
| HUD/状态栏               | ~400    | 宿主 UI 层覆盖        | —       |
| 通知子系统               | ~300    | 宿主有独立通知        | —       |
| Code-intel MCP           | ~200    | OpenClaw 可能原生支持 | —       |

**明确跳过小计: ~9,300 LOC**

### 6.3 技能差距（Skills Gap）

| 类别                                | omc 数量 | omm 数量 | 差距        |
| ----------------------------------- | -------- | -------- | ----------- |
| Tool-dispatch skills                | 2        | 2        | —           |
| 状态机 skills                       | 3        | 3        | —           |
| 模式 skills (plan/review/debug)     | 6        | 0        | 缺失        |
| Agent skills (architect/critic/...) | 8        | 0        | 缺失        |
| 工具 skills (deslop/sketch/...)     | 10       | 0        | 缺失        |
| Pipeline skills (ralplan/...)       | 3        | 0        | 缺失        |
| 测试/QA skills                      | 4        | 0        | 缺失        |
| 其他                                | 2        | 0        | 缺失        |
| **总计**                            | **38**   | **5**    | **33 缺失** |

### 6.4 MCP Server 差距

| MCP Server | omc | omm | 差距说明       |
| ---------- | --- | --- | -------------- |
| state      | ✓   | ✓   | omm 有简化版   |
| trace      | ✓   | ✗   | 执行轨迹，P2   |
| wiki       | ✓   | ✗   | 文档管理，按需 |
| memory     | ✓   | ✗   | 持久化 KV，P2  |
| code-intel | ✓   | ✗   | ADR 排除       |

---

## 七、积极发现

| #   | 发现              | 说明                                       |
| --- | ----------------- | ------------------------------------------ |
| 1   | ADR 驱动设计      | 4 份 ADR 记录关键决策，防止架构漂移        |
| 2   | 零依赖 MCP        | ~260 行手写 JSON-RPC，无供应链风险         |
| 3   | 状态验证分发器    | 单入口 + 模式扩展，设计清晰                |
| 4   | Team 委托模式     | thin bridge 避免了 omc 最复杂的子系统      |
| 5   | 合同文档          | 3 份 contract 文档定义接口不变量           |
| 6   | 原子写入          | tmp+rename 保证无部分写入                  |
| 7   | 默认注入          | 减少 SKILL.md 模板样板代码                 |
| 8   | Compliance 工具链 | scan-names/verify-bundle/verify-provenance |

---

## 八、修订 Roadmap

### Phase 1a: 安全与基础（~300 LOC，2-3 天）

| 交付物              | LOC | 验收标准                                |
| ------------------- | --- | --------------------------------------- |
| Path traversal 修复 | ~30 | key 包含 `../` 或特殊字符时写入被拒绝   |
| 同步 I/O → 异步     | ~20 | hooks 使用 async fs API                 |
| Key 白名单验证      | ~20 | key 只允许 `[a-z0-9_-]`                 |
| MCP server 基础测试 | ~80 | handshake + tool list + 读写 + 错误路径 |
| 共享验证模块抽取    | ~50 | MCP 和 plugin 使用同一验证函数          |

**完成后商用评分: ~35/100**

### Phase 1b: 工作流运行时（~1,200 LOC，1-2 周）

| 交付物            | LOC  | 验收标准                                |
| ----------------- | ---- | --------------------------------------- |
| 工作流互斥守卫    | ~200 | 任意时刻最多一个模式 active=true        |
| 统一模式生命周期  | ~300 | `startMode/updateState/cancelMode` 接口 |
| Ralph 持久化/恢复 | ~400 | 跨会话恢复 ralph 状态                   |
| 运行时完成契约    | ~150 | `RunOutcome` 类型 + 状态转换图          |
| 扩展测试          | ~150 | 覆盖率 > 60%                            |

**完成后商用评分: ~55/100（Beta 就绪）**

### Phase 2: 扩展能力（~1,500 LOC，2-3 周）

| 交付物           | LOC  | 验收标准                          |
| ---------------- | ---- | --------------------------------- |
| Pipeline 编排器  | ~400 | autopilot 多步执行 + 单步验证     |
| Ralplan 共识规划 | ~300 | Planner/Architect/Critic 三方共识 |
| Agent 角色定义   | ~200 | 至少 5 个角色提示词               |
| Hook 扩展 SDK    | ~300 | 动态 hook 加载                    |
| Memory MCP       | ~200 | read/write/list/delete            |
| Trace MCP        | ~100 | 事件记录 + 查询                   |

**完成后商用评分: ~70/100（生产就绪）**

### Phase 3: 精益求精（~800 LOC，持续）

| 交付物           | 验收标准                 |
| ---------------- | ------------------------ |
| 测试覆盖率 ≥ 80% | 含集成测试               |
| 完整 API 文档    | 所有 tool/skill/mcp 接口 |
| CI 自动化 bundle | omm-bundle 自动构建      |
| 性能基准         | 状态读写 < 10ms          |

---

## 九、P0 验收标准（Phase 1a + 1b 完成前不可发布）

- [ ] `key = "../../etc/passwd"` 被拒绝并返回错误
- [ ] 任意时刻只有 ralph/autopilot/team 其中之一可以 `active=true`
- [ ] Ralph 会话崩溃后可从持久化状态恢复
- [ ] MCP server 有 ≥ 10 个测试用例覆盖
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm omm:scan-names` 全量通过
- [ ] 所有 hooks 使用异步 I/O
- [ ] 覆盖率 ≥ 60%

---

## 十、待决问题

| #   | 问题                                    | 决策点                                           |
| --- | --------------------------------------- | ------------------------------------------------ |
| 1   | MCP 无认证是否可接受？                  | 桌面单用户场景可接受，多租户场景需加认证         |
| 2   | 是否需要状态转换图验证？                | 当前浅层验证足够，Phase 2 可考虑                 |
| 3   | 验证逻辑是否统一到单一模块？            | 建议统一，消除 plugin/MCP 验证分歧               |
| 4   | MCP server 是否注册到 `openclaw.json`？ | `omm-openclaw-seed.ts` 需添加 `mcp.servers` 配置 |
| 5   | omm 版本策略？                          | 需要与 omc 版本解耦，独立 semver                 |
