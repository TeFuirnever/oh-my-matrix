# omm (oh-my-matrix)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**OpenClaw Dynamic Workflows — AI 自主多 agent 编排。**

> **状态 (0.7.0):** Dynamic Workflows skill 包已交付。对标 Claude Code dynamic workflows——用户说自然语言，AI 自动生成 `.prose` 编排程序，经 OpenProse 扇出多 agent 并行执行，只回最终结果。

## 这是什么

oh-my-matrix 为 **OpenClaw 及衍生项目**提供 **AI 自主多 agent 编排能力**。核心是一个 SKILL.md 包（`skill/dynamic-workflows/`），教 OpenClaw agent 在任务需要时自动生成 `.prose` 工作流程序并经 OpenProse 执行——涵盖 8 种编排模式（fan-out-reduce / pipeline / adversarial-verify / loop-until-dry / routing / tournament / generate-and-filter / duel-loop）。

运行时由 OpenProse（OpenClaw bundled plugin）提供——不重复建设。

## 运行时安全（subagent guard）

Dynamic Workflows 扇出的 subagent 在 OpenClaw gateway 的 `before_tool_call`（priority 11）受运行时守卫保护——`destructive git`（reset --hard / force-push / clean）、文件清除（`rm` / `find -delete`）、credential / system-write、shell substitution（`$(...)`）、wrapper-exec（`npx` / `pnpm exec`）等在 `:subagent:` 会话被 **hard-block**，fail-closed（defaultDeny）。守卫代码在 `packages/{permission-policy, dynamic-workflows}`，设计见 [ADR-011/012/013](docs/adr/)，修复历史（placebo → 真守卫）见 [docs/fixes/runtime-guard-event-shape.md](docs/fixes/runtime-guard-event-shape.md)。

## 阅读地图（脊柱）

| 文档 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 架构总览与设计参考（已标注实现重置） |
| [docs/roadmap.md](docs/roadmap.md) | 路线图（Phase 1–4 为历史记录） |
| [CONTEXT.md](CONTEXT.md) | 领域语言与核心概念（Workflow Mode / Phase / State / Counter / Hook …） |
| [docs/adr/](docs/adr/) | 委托哲学与托管决策（ADR-002、008、010；011–013 运行时守卫） |
| [docs/fixes/](docs/fixes/) | 修复 spec（runtime-guard-event-shape：placebo → 真守卫，2026-06-28） |
| [docs/runbooks/](docs/runbooks/) | 运维手册（部署 + live 验证） |
| [docs/archive/](docs/archive/) | v0.x 实现的完整设计记录（ADR / 契约 / 计划 / 调研 / 评审），已归档 |
| [website/](website/) | VitePress 文档站点 |

## 本地预览文档站

```bash
pnpm install
pnpm docs:dev      # 本地开发服务器
pnpm docs:build    # 构建静态站点到 website/.vitepress/dist
```

## 仓库布局

```
.
├── docs/
│   ├── architecture.md      设计参考（脊柱）
│   ├── roadmap.md           路线图（脊柱）
│   ├── adr/                 委托哲学与托管 ADR（002 / 008 / 010）
│   ├── agents/              仓库协作约定（issue 跟踪、triage、领域文档）
│   └── archive/             v0.x 实现设计记录（历史，已归档）
├── packages/
│   ├── autopilot/           @openclaw/autopilot canonical 源码（托管，非 omm 交付物；见 ADR-010）
│   ├── dynamic-workflows/   @openclaw/dynamic-workflows — subagent 运行时守卫 plugin（before_tool_call priority 11）
│   └── permission-policy/   @openclaw/permission-policy — 守卫原语库（classifyCommand / decidePermission / audit）
├── scripts/
│   (internal host-deploy + deployed-dist smoke check, not in this repo)
├── skill/dynamic-workflows/ 核心交付物：AI 自主生成 .prose 编排
├── website/                 VitePress 文档站
├── CONTEXT.md               领域语言
├── AGENTS.md                AI 代理工作约定
└── CHANGELOG.md             变更历史
```

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全披露见 [SECURITY.md](SECURITY.md)。行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## License

[MIT](LICENSE).
