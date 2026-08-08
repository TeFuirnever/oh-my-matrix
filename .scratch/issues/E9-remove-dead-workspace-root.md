# E9 — 删 `workflow.workspace.root`

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P2-15
**被阻塞**: 无
**设计文档**: §5.9、§7 迁移表

---

## 做什么

删除 WORKFLOW.md 的 `workspace.root` 配置项。它**运行时不消费**——`workflow-config.ts:165` 的注释自承：

> `workspace.root is not consumed at runtime today (autopilot delegates worktree …)`

删除是对 **ADR-008**（worktree 管理委托 host）的落实，不是违反。

## 🚨 两个同名字段，删错即毁数据

| 字段 | 位置 | 处置 |
|---|---|---|
| **`workflow.workspace.root`** | WORKFLOW.md 配置项，`workflow-config.ts:170,173` | ✅ **本 ticket 要删的** |
| **`state.workspace.root`** | `index.ts:208`（checkpoint 根）、`:879`（workspaceRoot） | 🚨 **绝不可动** —— P0-2 / E1 的核心，误删即毁掉持久化 |

设计文档 v1 曾把前者笼统写成「从未生效」，措辞会误导。**动手前先确认改的是 `workflow.` 前缀那个。**

## 兼容性

WORKFLOW.md 里写了该字段的用户会收到 "Unknown field" 警告（`workflow-config.ts:131-135`）——属**预期行为**，不是回归。

## 验收

- [ ] `workflow.workspace.root` 及其校验逻辑已删
- [ ] `state.workspace.root` **未被触碰**（diff 自检）
- [ ] 旧 WORKFLOW.md 收到 Unknown field 警告而非崩溃
- [ ] checkpoint 读写不受影响（回归测试）
