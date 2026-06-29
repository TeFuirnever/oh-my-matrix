---
name: harness
description: "How to use and extend the oh-my-matrix development harness. Run the gates locally before pushing, locate each config, add a new gate, and follow the commit convention. Use when onboarding to OMM, running checks before a push, or adding/modifying a quality gate. Triggers: 'run the harness', 'pnpm check', 'pnpm verify', 'add a lint rule', 'add a gate', 'how do gates work', 'commit format', 'harness'."
---

# OMM Development Harness

The harness guards TS source, docs, and commit messages. **Every gate runs identically locally and in CI** — `pnpm check` / `pnpm verify` mirror the pipeline, so what passes on your laptop passes in GitHub Actions.

Design rationale: [docs/design/dev-harness.md](../../docs/design/dev-harness.md). PR lifecycle: the [`work-with-pr`](../work-with-pr/SKILL.md) skill.

## The commands

```bash
pnpm check   # lint (eslint) + markdownlint + typecheck   ← static gates
pnpm verify      # check + pnpm -r test + pnpm docs:build     ← full local CI mirror
pnpm lint    # eslint .
pnpm lint:md # markdownlint-cli2 (all .md, archive excluded)
pnpm typecheck # pnpm -r typecheck (tsc --noEmit per package)
pnpm -r test # vitest run across all workspaces
```

Run `pnpm verify` before pushing. CI (`.github/workflows/ci.yml`) splits these into `lint` / `typecheck` / `commitlint` / `test` jobs with concurrency cancellation and per-job summaries.

## Where things live

| Concern | File |
|---|---|
| ESLint (flat, TS-aware) | `eslint.config.mjs` |
| Markdownlint (lenient prose) | `.markdownlint-cli2.jsonc` |
| Commitlint (Conventional Commits) | `commitlint.config.mjs` |
| Node version | `.nvmrc` (20), `package.json` `engines.node` |
| Local `commit-msg` hook | `package.json` `simple-git-hooks` → installed via `prepare` |
| CI pipeline | `.github/workflows/ci.yml` |
| Docs build / deploy | `.github/workflows/docs.yml` |
| Repo MCPs | `.mcp.json` (codegraph) |

## Commits

Conventional Commits, enforced both by a local `commit-msg` hook (installed on `pnpm install`) and a CI job:

```
feat: …  fix: …  docs: …  style: …  refactor: …  perf: …  test: …  chore: …  ci: …  build: …  revert: …
```

Header ≤ 100 chars. (Full set documented in `CONTRIBUTING.md` §6.)

## Adding a gate

1. Add the script to root `package.json` `scripts` (and any needed devDependency).
2. Fold it into `check` (static) or `ci` (full mirror) so it runs locally the same way CI does.
3. Add the matching step in `.github/workflows/ci.yml` (reuse the lint/typecheck job shape: checkout → pnpm setup → node 20 + cache → `pnpm install --frozen-lockfile` → your command → summary step).
4. If it has a config file, add it to the table above.

Keep gates right-sized: OMM is a small, docs-first repo. Don't add a gate that churns existing docs/source to pass — match the established style instead (see how markdownlint's stylistic rules were relaxed and `no-explicit-any` is a non-blocking `warn`).
