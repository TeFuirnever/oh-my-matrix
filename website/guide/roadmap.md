# Roadmap

> 🔄 **实现已重置 (0.6.0)** — v0.x 实现已移除。下方为方向性概要；完整路线图（含 Phase 1–4 历史记录）见仓库 [`docs/roadmap.md`](https://github.com/your-org/oh-my-matrix/blob/master/docs/roadmap.md)。

## 当前状态

仓库为**文档/设计底座**，无代码。连续方向（OpenClaw 原生 `team` 编排 + 委托宿主）保留；下一阶段的具体实现形态待定。

## 明确不做（Non-Goals，方向连续）

| 不做 | 原因 |
|------|------|
| 独立 CLI | OpenClaw Gateway 提供工具分派 |
| tmux/worktree 并行 | 宿主提供 team 原语 |
| 自建自主循环 / 目标 | 委托宿主 `@openclaw/autopilot` |
| Rust 原生模块 | 纯插件架构不需要 |

## 历史

v0.x 的 Phase 1–4（工作流运行时、扩展 MCP、扩展性、智能体库 + MCP 能力面）记录在仓库 `docs/roadmap.md`，作为方向演进的历史追溯保留。

→ 委托哲学见 [ADR-002](/reference/adrs/002)。
