# Design Reference

> 🔄 **实现已重置 (0.6.0)** — 以下为设计参考入口。v0.x 实现已移除，完整设计记录归档于仓库 `docs/archive/`。

## 脊柱（连续方向）

- **领域语言** — 仓库 `CONTEXT.md`：Workflow Mode / Phase / State / Counter / Hook / RunOutcome / Skill 等核心概念。
- **架构叙事** — 仓库 `docs/architecture.md`。
- **路线图** — 仓库 `docs/roadmap.md`（Phase 1–4 为历史记录）。

## 委托哲学（ADR）

- [ADR-002: Team Delegation to Host](/reference/adrs/002) — 团队并行委托宿主（连续脊柱）。
- 仓库 `docs/adr/008-delegation-to-host.md` — 自主循环 / 目标委托宿主（连续脊柱）。

## 历史设计记录（已归档）

仓库 `docs/archive/` 保留 v0.x 完整设计记录，作为历史知识（内部链接可能失效，有意不修复）：

- **ADR**（001 纯插件 / 003 零依赖 MCP / 004 三模状态机 / 005 跨进程锁 / 006 MCP 内联生成 / 007 goal 模式）
- **Contracts**（state / workflow-state / hooks / error-codes / observability / degradation / mcp / skill-lifecycle / …）
- **Plans / Specs / Research / Reviews**

> 归档说明见仓库 `docs/archive/README.md`。
