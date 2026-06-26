# Contributing to oh-my-matrix (omm)

Thank you for your interest in contributing to oh-my-matrix!

> **状态 (0.6.0):** 本仓库现为**文档与设计仓库**——v0.x 的 OpenClaw 插件 / MCP 实现已移除，设计记录归档于 [`docs/archive/`](docs/archive/)。贡献以**文档与设计**为主。

## 仓库结构

```
.
├── docs/
│   ├── architecture.md      架构叙事（脊柱）
│   ├── roadmap.md           路线图（脊柱）
│   ├── adr/                 委托哲学 ADR（002 / 008）
│   ├── agents/              仓库协作约定
│   └── archive/             v0.x 实现设计记录（历史，不再维护）
├── website/                 VitePress 文档站
├── CONTEXT.md               领域语言
├── AGENTS.md                AI 代理工作约定
└── CHANGELOG.md             变更历史
```

## 前置环境

- Node.js 20+
- pnpm 10+（仓库通过 `packageManager` 锁定 `pnpm@10.24.0`）

仅需 VitePress 用于本地预览文档站；无需 TypeScript / 构建工具链。

## 文档工作流

1. 从 `master` 创建分支。
2. 编辑 markdown 文档。
3. 本地预览：
   ```bash
   pnpm install
   pnpm docs:dev      # 本地开发服务器
   pnpm docs:build    # 构建静态站点，验证无破坏
   ```
4. 提交并以 conventional commit 规范开 PR 指向 `master`。

## 编辑约定

- **脊柱文档**（`CONTEXT.md`、`docs/architecture.md`、`docs/roadmap.md`、`docs/adr/`）是面向未来的活跃表面，改动需谨慎并说明动机。
- **`docs/archive/`** 是 v0.x 的历史快照——**只读保留**，不重写历史；内部链接可能失效（有意不修复，见 `docs/archive/README.md`）。
- 中英混排可接受（与现有文档一致）。markdown 风格保持与周围一致。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

| 前缀       | 用途          |
| ---------- | ------------- |
| `docs:`    | 文档变更      |
| `refactor:`| 结构重构      |
| `chore:`   | 工具、CI、配置 |
| `fix:`     | 修正          |
| `feat:`    | 新内容/功能   |

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

## 贡献指南（中文摘要）

- **环境**: Node.js 20+, pnpm 10+；仅需 VitePress 预览文档站。
- **流程**: 从 `master` 分支 → 编辑 markdown → `pnpm docs:build` 验证 → PR。
- **约定**: 脊柱文档谨慎改；`docs/archive/` 只读保留；Conventional Commits。
- **许可**: 贡献即同意以 MIT 许可发布。
