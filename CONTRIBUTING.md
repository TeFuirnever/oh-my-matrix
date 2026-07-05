# Contributing to oh-my-matrix

Thanks for contributing. This repo is small, safety-sensitive, and docs-first. Good contributions are specific, tested, and honest about what is source truth versus host-deployed truth.

## Project Shape

| Area | Path | What changes here need |
|---|---|---|
| Autopilot | `packages/autopilot/` | package tests plus host-deploy awareness |
| Dynamic Workflows guard | `packages/dynamic-workflows/` | guard tests plus event-shape care |
| Permission Policy | `packages/permission-policy/` | command classification tests and audit checks |
| Dynamic Workflows skill | `packages/dynamic-workflows/skill/` | prompt/behavior review and realistic examples |
| Spine docs | `README.md`, `CONTEXT.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/adr/` | consistency sweep across public docs |
| Archive | `docs/archive/` | preserve history; do not rewrite old records |

## Local Setup

```bash
pnpm install
pnpm -r build   # dist/ is not committed (ADR-015); typecheck + tests need it built
```

Useful checks:

```bash
pnpm --filter @oh-my-matrix/autopilot test
pnpm --filter @oh-my-matrix/dynamic-workflows test
pnpm --filter @oh-my-matrix/permission-policy test
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
6. Use Conventional Commits: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `chore:`, `ci:`, `build:`, `revert:` (enforced by commitlint — local hook + CI; **body lines must stay ≤ 100 chars**).
7. `master` is protected: PRs need the `test` check green and use squash-merge; direct pushes and force-pushes are blocked.

## Repository Setup

The repo's automation and policy live under `.github/`:

| Setting | File | What it does |
|---|---|---|
| CI | `.github/workflows/ci.yml` | On push/PR: 4 jobs — lint (eslint + markdownlint), typecheck, commitlint (PR only), test. Concurrency cancel + pnpm cache + per-job summaries |
| Docs deploy | `.github/workflows/docs.yml` | On push to `master`: builds `landing` + VitePress, deploys to GitHub Pages |
| Branch protection | GitHub settings | `master` requires the `test` check green + squash-merge; direct/force pushes blocked (see Pull Request Rules above) |
| Dependency scan | `.github/dependabot.yml` | Dependabot watches dependency updates and security advisories |
| Code ownership | `.github/CODEOWNERS` | Default reviewers per path |
| PR template | `.github/PULL_REQUEST_TEMPLATE.md` | Structured PR description |
| Issue templates | `.github/ISSUE_TEMPLATE/` | bug / feature request forms |

To add a gate or adjust CI, see the `harness` skill and [`docs/design/dev-harness.md`](docs/design/dev-harness.md).

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

## Releasing

The repo hosts three npm packages under `@oh-my-matrix`:
[`permission-policy`](packages/permission-policy),
[`dynamic-workflows`](packages/dynamic-workflows),
[`autopilot`](packages/autopilot).

### Publish order (peer-dependency graph)

```
permission-policy  (leaf — no peerDeps)
dynamic-workflows  (peerDeps: permission-policy)
autopilot          (peerDeps: permission-policy)
```

Always publish leaf-first. The publish script enforces this order.

### Version bumping (manual)

The publish script does NOT auto-bump versions — that is a human decision
following [semver](https://semver.org/):

| change type | bump | example |
|---|---|---|
| Skill/prompt layer (SKILL.md, role-prompts, references) | patch or minor | new role-prompt → minor; typo fix → patch |
| Runtime code (index.ts, src/) | minor | new hook registration → minor |
| Public API break (removed export, changed signature) | major | trustWorkspace default flip → 3.0.0 |

When bumping `package.json`, **also bump `openclaw.plugin.json`** (if present)
to the same version — the publish script validates this alignment and refuses
to publish on drift.

### Publishing

**Option A — local script:**

```bash
./scripts/publish.sh --dry-run   # validate first (always do this)
./scripts/publish.sh             # real publish
```

**Option B — GitHub Actions:**

Trigger the **Release** workflow from the Actions tab
(`workflow_dispatch`). Set `dry_run: true` to validate first.

Both paths run the same pipeline: pre-flight validation → build → publish in
dependency order → verify published artifacts → tag the release commit.

### What the script validates

- `package.json` version == `openclaw.plugin.json` version (no drift)
- local version > registry version (no accidental re-publish)
- working tree clean (no uncommitted state shipped)
- npm logged in (real publish only)
- published tarball contains expected files (deep verification post-publish)

### Tags

The script tags each release as `{package}-v{version}`
(e.g. `autopilot-v3.0.0`). Tags are annotated and pushed automatically.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
