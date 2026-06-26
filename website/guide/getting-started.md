# Getting Started

> 🔄 **实现已重置 (0.6.0)** — 本仓库现为文档/设计底座，无可运行代码。下面介绍如何浏览文档与本地预览文档站。

## 这是什么

oh-my-matrix (omm) 探索 **OpenClaw 原生的工作流编排**：以纯插件形式为任何 OpenClaw 兼容宿主提供 `team` 协作编排，自主循环与目标能力委托宿主。

此前 v0.x 的 OpenClaw 插件 / MCP 实现（`team` 状态机、employee-bridge、hooks、MCP servers）已于 0.6.0 全部移除，设计记录归档保留。

## 浏览文档

| 想了解 | 去哪看 |
|--------|--------|
| 方向与架构叙事 | [Architecture](/guide/architecture)、仓库 `docs/architecture.md` |
| 路线图与历史阶段 | [Roadmap](/guide/roadmap)、仓库 `docs/roadmap.md` |
| 领域语言与核心概念 | 仓库 `CONTEXT.md`（Workflow Mode / Phase / State / Counter / Hook …） |
| 委托哲学（连续脊柱） | [ADR-002](/reference/adrs/002)、仓库 `docs/adr/002`、`docs/adr/008` |
| v0.x 完整设计记录 | 仓库 `docs/archive/`（ADR / 契约 / 计划 / 调研 / 评审，已归档） |

## 本地预览文档站

```bash
pnpm install
pnpm docs:dev      # 启动本地开发服务器（默认 http://localhost:5173）
pnpm docs:build    # 构建静态站点到 website/.vitepress/dist
pnpm docs:preview  # 预览构建产物
```

仅需 Node.js 20+ 与 pnpm 10+；VitePress 是唯一依赖，无需 TypeScript / 构建工具链。

## 下一步

- [Architecture](/guide/architecture) — 架构叙事与设计参考
- [Roadmap](/guide/roadmap) — 路线图（Phase 1–4 为历史记录）
- [Design Reference](/reference/) — 设计参考入口
