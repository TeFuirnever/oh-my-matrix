# Contributing to oh-my-matrix

Thanks for contributing. This repo is small, safety-sensitive, and docs-first. Good contributions are specific, tested, and honest about what is source truth versus host-deployed truth.

## Project Shape

| Area | Path | What changes here need |
|---|---|---|
| Autopilot | `packages/autopilot/` | package tests plus host-deploy awareness |
| Dynamic Workflows guard | `packages/dynamic-workflows/` | guard tests plus event-shape care |
| Permission Policy | `packages/permission-policy/` | command classification tests and audit checks |
| Dynamic Workflows skill | `skill/dynamic-workflows/` | prompt/behavior review and realistic examples |
| Spine docs | `README.md`, `CONTEXT.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/adr/` | consistency sweep across public docs |
| Archive | `docs/archive/` | preserve history; do not rewrite old records |

## Local Setup

```bash
pnpm install
```

Useful checks:

```bash
pnpm --filter @openclaw/autopilot test
pnpm --filter @openclaw/dynamic-workflows test
pnpm --filter @openclaw/permission-policy test
pnpm docs:build
git diff --check
```

The commands above are now part of a multi-gate harness — run the full local mirror of CI before pushing:

```bash
pnpm verify   # lint + markdownlint + typecheck + workspace tests + docs build
pnpm check # lint + markdownlint + typecheck (static gates only)
```

Gates: `pnpm lint` (eslint), `pnpm lint:md` (markdownlint), `pnpm typecheck` (`tsc --noEmit` per package), `pnpm -r test` (vitest). Commits must follow Conventional Commits — enforced by a local `commit-msg` hook (installed automatically on `pnpm install`) and re-checked in CI. See [docs/design/dev-harness.md](docs/design/dev-harness.md) and the `harness` skill for the full picture and how to add a gate.

## Pull Request Rules

1. Start from `master`.
2. Keep the change surgical.
3. Add or update tests for code behavior changes.
4. For docs changes, update every public surface that would otherwise contradict the new claim.
5. Do not claim host deployment is complete unless the host dist was actually refreshed and smoke-tested.
6. Use Conventional Commits: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `chore:`, `ci:`, `build:`, `revert:` (enforced by commitlint — local hook + CI).
7. `master` is protected: PRs need the `test` check green and use squash-merge; direct pushes and force-pushes are blocked.

## Issue Quality

Good issues include:

- exact package or doc path
- expected behavior
- actual behavior
- command output or link to evidence
- whether the problem is source-only or host-deployed

Security reports should follow [`SECURITY.md`](SECURITY.md), not public issues.

## Generated Assets

Images in this repo must be reproducible:

- store the prompt near the asset or document it in `docs/credits.md`
- include tool/backend, date, and license
- current visual direction is hand-drawn technical diagrams

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
