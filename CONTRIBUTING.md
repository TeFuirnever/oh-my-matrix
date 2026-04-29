# Contributing to oh-my-matrix (omm)

Thank you for your interest in contributing to oh-my-matrix!

## Prerequisites

- Node.js 20+
- pnpm 10+ (the repo pins `pnpm@10.24.0` via `packageManager`)
- TypeScript 5.7+

## Setup

```bash
git clone <repo-url>
cd oh-my-matrix
pnpm install
pnpm build
pnpm test
```

## Repository Structure

oh-my-matrix is a pnpm monorepo with four packages:

| Package          | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `omm-plugin`     | OpenClaw plugin — tools, state validation, workflow lifecycle |
| `omm-mcp`        | MCP state server (stdio JSON-RPC)                             |
| `omm-mcp-memory` | MCP memory server (key-value over `stateRoot/memory/`)        |
| `omm-mcp-trace`  | MCP trace server (append-only JSONL execution log)            |

All packages live under `omm-packages/`. Build scripts and verification tooling are in `omm-scripts/`.

## Development Workflow

1. Create a branch from `main`.
2. Make your changes with focused commits.
3. Run the quality gate:
   ```bash
   pnpm lint        # Biome check
   pnpm build       # Compile all packages
   pnpm test        # Node.js built-in test runner
   ```
4. Open a Pull Request targeting `main`.

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix      | Usage              |
| ----------- | ------------------ |
| `feat:`     | New feature        |
| `fix:`      | Bug fix            |
| `refactor:` | Code refactoring   |
| `docs:`     | Documentation      |
| `test:`     | Tests              |
| `chore:`    | Build, tooling, CI |

## Code Style

- **Linter/Formatter**: [Biome](https://biomejs.dev/) — run `pnpm lint`
- **Zero runtime dependencies**: MCP servers must remain dependency-free (see ADR-003)
- **Path-traversal safety**: All key inputs must be validated against the allowlist pattern
- **Atomic writes**: Use tmp+rename for state file writes
- **Immutability**: Prefer returning new objects over mutation

## Testing

- **Framework**: Node.js built-in test runner (`node --test`)
- **Coverage**: `pnpm test:coverage` (target: 90%+, currently 96.83%)
- **All PRs must include tests** for new functionality

## Verification Scripts

```bash
pnpm omm:scan-names        # Check for forbidden naming
pnpm omm:verify-bundle     # Verify suite tarball integrity
pnpm omm:verify-provenance # Verify provenance entries
pnpm omm:smoke-mcp         # MCP server smoke test
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

## 贡献指南（中文摘要）

欢迎参与 oh-my-matrix 开发！

- **环境要求**: Node.js 20+, pnpm 10+
- **开发流程**: 从 `main` 创建分支 → 修改 → `pnpm lint && pnpm build && pnpm test` → PR
- **提交规范**: Conventional Commits（`feat:` / `fix:` / `docs:` 等）
- **代码风格**: Biome lint，零运行时依赖（MCP 服务器），原子写入
- **测试**: Node.js 内置测试框架，覆盖率 90%+
- **许可**: 贡献即同意以 MIT 许可发布
