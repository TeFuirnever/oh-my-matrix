# 归档 / Archive

> 🗄 本目录保存 **oh-my-matrix v0.x 实现**（OpenClaw 插件 + MCP 服务器 + 团队编排）的设计记录。
> 代码已于 **0.6.0** 全部移除，仓库现为**文档/设计底座**，为下一阶段方向铺路。
> 这些文档作为**历史知识**保留，不反映当前代码状态。

## 为什么归档（而不是删除）

删除代码 ≠ 删除设计思考。这些 ADR、契约、计划、调研、评审记录了"为什么这么设计"的推理过程，对未来方向仍是参考。归档让它们**退出 live 文档表面**（不再误导读者以为描述的是现存代码），同时**保留可查的设计知识**。

## 免责声明

- ⚠️ **内部交叉链接可能已失效**：归档文件之间的相对链接（如 `contracts/` ↔ `adr/`、指向 `../../architecture.md`）保留了原始路径，迁移后部分会指向不存在或已移动的目标。这是**有意不修复**的——它们是历史快照，不是需要维护的活文档。
- ⚠️ 文中提到的源文件（`omm-*.ts`、`omm-scripts/*.mjs`、`omm-packages/*`）、脚本（`pnpm build/test/omm:*`）、产物（`omm-suite-*.tgz`）**均已不存在**。
- 如需理解当前方向，请读**顶层脊柱**：[`../architecture.md`](../architecture.md)、[`../roadmap.md`](../roadmap.md)、[`../adr/002-team-delegation-to-host.md`](../adr/002-team-delegation-to-host.md)、[`../adr/008-delegation-to-host.md`](../adr/008-delegation-to-host.md)。

## 目录

### ADR（架构决策记录，实现型）

| ADR | 主题 |
|-----|------|
| [001](adr/001-pure-plugin-no-cli.md) | Pure Plugin, No CLI |
| [003](adr/003-zero-dependency-mcp.md) | Zero-Dependency Hand-Written MCP |
| [004](adr/004-three-mode-state-machine.md) | Three-Mode State Machine |
| [005](adr/005-cross-process-locking.md) | Cross-Process Locking |
| [006](adr/006-mcp-inline-build-generation.md) | MCP Inline Build-Time Code Generation |
| [007](adr/007-goal-mode.md) | Goal Mode |

> 委托哲学类 ADR（002、008）保留在顶层 [`../adr/`](../adr/)，作为连续方向的脊柱。

### 契约 / Contracts

`degradation` · `error-codes` · `goal-state-contract` · `hooks` · `ma-integration-snippets` · `mcp-protocol-contract` · `mcp` · `observability` · `skill-lifecycle` · `state-contract` · `workflow-state-contract` —— 见 [`contracts/`](contracts/)。

### 计划 / Plans · 规格 / Specs

- [`plans/`](plans/) — omm-ma-employee-bridge、omm-plugin-enhancement-v0.5
- [`specs/`](specs/) — omm-ma-employee-bridge-spec

### 调研 / Research

- [`research/`](research/) — mcp-capability-survey、mcp-progress-notification-survey

### 评审 / Reviews

- [`reviews/`](reviews/) — 2026-04-26 architecture-review、2026-05-12 architecture-deepening
