# Architecture

> 🔄 **实现已重置 (0.6.0)** — v0.x 的 OpenClaw 插件 / MCP / team 编排实现已全部移除。以下保留**连续方向的架构叙事**；完整设计参考见仓库 [`docs/architecture.md`](https://github.com/your-org/oh-my-matrix/blob/master/docs/architecture.md)。

## 定位

oh-my-matrix 为任何 OpenClaw 兼容宿主提供 **`team` 工作流编排**（以及数字员工桥）。自主循环与目标能力**委托给宿主**。它借鉴 oh-my-codex，但重设计为**纯插件**——无独立 CLI、无原生模块、零运行时依赖。

## 核心概念

- **纯插件，无 CLI**：通过 OpenClaw Plugin ABI 暴露可选工具与生命周期 hooks；宿主在没有 omm 时仍正常工作。
- **单一工作流模式 `team`**：围绕共享计划编排并行代理，`planning → decomposing → delegating → executing → synthesizing → verifying ↔ fixing → complete | failed | blocked`；同一时刻至多一个 active。
- **双通道状态访问**：同一状态目录可经插件工具（进程内）与 MCP server（进程外）访问，写入前均校验。
- **委托给宿主**：团队并行、自主循环、目标能力交给宿主（Gateway / `TeamCreate`·`TaskCreate`·`SendMessage` / `@openclaw/autopilot`）。

## 后续方向

实现重置后待定：`team` 编排以何种形态回归（纯插件 / MCP / 二者）、数字员工桥是否保留、文档站如何承载未来设计迭代。

→ 完整架构叙事与历史依据见仓库 `docs/architecture.md`；委托哲学见 [ADR-002](/reference/adrs/002)。
