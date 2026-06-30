# Design: OMM Development Harness

| | |
|---|---|
| **Status** | Implemented — all 4 phases shipped (eslint/markdownlint/commitlint/typecheck gates, `pnpm check` + `pnpm verify`, `ci.yml` 4-job split with concurrency + summaries, `.mcp.json`, `skill/harness` + `skill/work-with-pr`) |
| **Date** | 2026-06-28 (proposed) · implemented 2026-06-29 (PR #14) |
| **Scope** | `packages/*`, root configs, `.github/workflows/`, `.mcp.json`, `skill/` |
| **References** | [oh-my-openagent (dev)](https://github.com/code-yeongyu/oh-my-openagent/tree/dev) · [work-with-pr skill](https://github.com/code-yeongyu/oh-my-opencode/blob/dev/.opencode/skills/work-with-pr/SKILL.md) · ECC (local reference) · `AGENTS.md`, `CONTRIBUTING.md`, `docs/adr/` |

> 摘要：为 oh-my-matrix 建设一套"开发 Harness"——通过 **typecheck / eslint / markdownlint / commitlint / CI 拆分 / 本地 git hook / `.mcp.json` / 两个 skill** 多重能力看护仓库开发。参考 `oh-my-openagent` 与 ECC 的最佳实践，但按 OMM「小而 docs-first」的特点做**适度裁剪**，不照搬其重型机械（10 个 workflow、50 个校验脚本、SLSA）。

---

## 1. Background & Problem

`oh-my-matrix` is a small, **docs-first** pnpm monorepo. It hosts three real TypeScript packages
(`@oh-my-matrix/autopilot`, `@oh-my-matrix/dynamic-workflows`, `@oh-my-matrix/permission-policy`), a VitePress
`website/`, a hand-drawn `landing/`, `docs/`, and `packages/dynamic-workflows/skill/`.

Its current development harness is **thin and leaky**:

- `.github/workflows/ci.yml` runs only `pnpm install` + `pnpm -r test`.
  **`tsc` is never executed in CI**, so type errors in *non-test* source code silently slip through.
- There is **no lint** (ESLint), **no markdownlint**, **no commit-message enforcement**, **no
  format gate**, **no CI concurrency control**, and **no job summaries**.
- There is **no `.mcp.json`**, and the PR-lifecycle skill (`work-with-pr`) that forms the essence
  of the `oh-my-openagent` agent harness is absent.

Per-package scripts at proposal time were `build` (`tsc`), `test` (`vitest run`), `pack` — uniform, but with
no `typecheck` / `lint`. Root `devDependencies` contains only `vitepress`.

## 2. Goals & Non-Goals

**Goals**

1. Every quality gate runs **identically locally** (`pnpm <script>`) **and in CI**.
2. Close the broken-build hole: a failing **typecheck** blocks merge.
3. Lint **TS source** and **markdown docs**, enforce **Conventional Commits** locally + in CI.
4. Give agents + humans an **MCP + skills layer** that encodes the gates (`work-with-pr`).
5. One command — `pnpm verify` — mirrors the entire CI pipeline on a laptop.

**Non-Goals (deferred unless explicitly requested)**

- Reusable / matrix workflows, `tests/ci` repo self-tests & validators (ECC).
- Supply-chain watch, Dependabot, SLSA provenance.
- PR target-branch guard (OMM flow is PR→`master`, not `dev`→`master`).
- Type-checking test files (`vitest --typecheck`).
- 3-OS CI matrix.

## 3. Design Principles

- **Right-sized, not copy-pasted.** OMM is small and docs-first. Mirror the *high-leverage*
  patterns of the two references, not their volume.
- **Local == CI.** No gate exists only in CI. `pnpm check` and `pnpm verify` are the canonical runs.
- **Shortest working diff.** Reuse each package's existing `tsconfig.json`; add a `typecheck`
  script rather than re-architecting with project references.
- **Deletion over addition.** One local `commit-msg` hook, no pre-commit lint churn.

## 4. Current State vs. Target

| Capability | Today | Target |
|---|---|---|
| TS typecheck in CI | ❌ (tsc never runs) | ✅ per-package `typecheck`, CI job |
| ESLint | ❌ | ✅ flat config, TS-aware |
| Markdownlint | ❌ | ✅ lenient prose config |
| Commit message lint | ❌ (CONTRIBUTING says, nothing enforces) | ✅ commitlint config + local hook + CI job |
| CI structure | 1 job, `install`+`test` | split `lint` / `typecheck` / `commitlint` / `test` |
| CI concurrency | ❌ | ✅ `cancel-in-progress` |
| Job summaries | ❌ | ✅ inline `$GITHUB_STEP_SUMMARY` |
| MCP declared in-repo | ❌ | ✅ `.mcp.json` (codegraph) |
| PR-lifecycle skill | ❌ | ✅ `work-with-pr` (OMM gates) |
| Harness onboarding | scattered | ✅ `harness` meta-skill + CONTRIBUTING section |

## 5. Design

### Phase 1 — Code-quality gates (the real gap)

**1.1 Per-package `typecheck`.** Add `"typecheck": "tsc --noEmit"` alongside the existing
`build`/`test`/`pack` in each of `packages/autopilot`, `packages/dynamic-workflows`,
`packages/permission-policy`. `--noEmit` reuses the existing strict `tsconfig.json` (which excludes
`tests`). *(Tests are not typechecked here — see Non-Goals.)*

**1.2 ESLint (flat config, TS-aware).** Create `eslint.config.mjs` (OMM is `"type":"module"` → ESM
flat config). Combine `@eslint/js` recommended + `typescript-eslint` recommended; the `_`-prefixed
ignore idiom (`argsIgnorePattern: '^_'`); `eqeqeq: 'warn'`. Lint `packages/**/*.ts`,
`packages/*/index.ts`, and root `.mjs`/scripts.

```js
// eslint.config.mjs (sketch)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist', '**/node_modules', 'website/.vitepress/dist', 'landing',
              '.codegraph', '.context', '.autopilot', 'coverage', 'packages/*/*.tgz'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'eqeqeq': 'warn',
    },
  },
);
```

**1.3 Root scripts.** Add to root `package.json`:

```jsonc
"engines": { "node": ">=20" },
"scripts": {
  "docs:dev": "vitepress dev website",
  "docs:build": "vitepress build website",
  "docs:preview": "vitepress preview website",
  "lint": "eslint .",
  "lint:md": "markdownlint-cli2",
  "typecheck": "pnpm -r typecheck",
  "check": "pnpm lint && pnpm lint:md && pnpm typecheck",
  "ci": "pnpm check && pnpm -r test && pnpm docs:build",
  "prepare": "simple-git-hooks"
}
```

`pnpm check` = static-gate bundle. `pnpm verify` = full local CI mirror.

### Phase 2 — Docs + commit discipline

**2.1 Markdownlint.** Create `.markdownlint.json` — lenient for prose: `MD013` (line length) off,
`MD024` (duplicate headings) allow siblings. `ignores`: `node_modules`, `website`,
`CHANGELOG.md` (auto-generated), `.codegraph`, `.context`, `.autopilot`.

**2.2 Commitlint.** Create `commitlint.config.mjs` extending `@commitlint/config-conventional`,
with `type-enum` = `feat,fix,docs,style,refactor,perf,test,chore,ci,build,revert` (matches
the Conventional Commits set, documented in `CONTRIBUTING.md` §6), `header-max-length: 100`.

**2.3 Local hook (`simple-git-hooks`).** Root `package.json` devDeps + config:

```jsonc
"simple-git-hooks": { "commit-msg": "npx --no -- commitlint --edit \"$1\"" }
```

`pnpm install` runs `prepare` → installs the `commit-msg` hook for every clone. Pre-commit lint
churn is intentionally skipped — the commit-message gate is the meaningful one; CI catches the rest.

### Phase 3 — CI upgrade (`.github/workflows/ci.yml`)

Rewrite mirroring `oh-my-openagent`: **split jobs**, **`concurrency.cancel-in-progress`**,
**pnpm cache**, **inline job summaries** (`$GITHUB_STEP_SUMMARY`, `if: always()`). Keep Node 20
(add `.nvmrc` = `20`).

```yaml
name: CI
on:
  push: { branches: [master] }
  pull_request: { branches: [master] }
permissions: { contents: read }
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint && pnpm lint:md
      - if: always()
        run: printf '### Lint\n`%s`\n' "${{ job.status }}" >> "$GITHUB_STEP_SUMMARY"
  typecheck:
    runs-on: ubuntu-latest
    steps: [ …setup…, pnpm install --frozen-lockfile, pnpm typecheck, summary ]
  commitlint:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps: [ …setup…, pnpm install --frozen-lockfile,
             pnpm commitlint --from "${{ github.event.pull_request.base.sha }}"
                             --to   "${{ github.event.pull_request.head.sha }}" ]
  test:
    runs-on: ubuntu-latest
    steps: [ …setup…, pnpm install --frozen-lockfile, pnpm -r test, summary ]
```

> **Prerequisite:** confirm `pnpm-lock.yaml` is committed — CI uses `--frozen-lockfile`.
> If absent, run `pnpm install` once and commit the generated lockfile.

`.github/workflows/docs.yml` (Pages deploy) is unchanged — it already assembles `landing` + VitePress.

### Phase 4 — Agent layer (MCP + skills)

**4.1 `.mcp.json`** (repo-portable MCP declaration; `oh-my-openagent` keeps one at root):

- **codegraph** — shipped as `codegraph serve --mcp` (stdio), mirroring the working global config
  and the live daemon at `.codegraph/daemon.sock`. OMM already has a live index
  (`.codegraph/codegraph.db`); the in-repo declaration makes it portable/discoverable for
  contributors and agents (not only the global user config). *Note:* codegraph is already exposed
  globally (`mcp__codegraph__*`), so this declaration's value is portability, not a new capability.

**4.2 `work-with-pr` skill** (`skill/work-with-pr/SKILL.md`) — a port + slimming of
`oh-my-openagent`'s `work-with-pr`: full PR lifecycle in a task-owned worktree, atomic-PR
decomposition, **unbounded verify loop**. OMM's gates (not oh-my-openagent's):

```
Gate A: CI          → gh pr checks   (lint + lint:md + typecheck + test)
Gate B: review-work → code-reviewer agent pass
Gate C: docs-build  → pnpm docs:build green
```

Drops oh-my-openagent's `Cubic` (third-party bot OMM lacks); replaces it with `docs-build`
(genuine for a docs-first repo). Retains: worktree isolation, branch off `master`, merge-by-default,
post-merge cleanup, "smallest PR that compiles + passes + stands alone" as the delivery unit.

**4.3 `harness` meta-skill** (`skill/harness/SKILL.md`) + **`CONTRIBUTING.md` Harness section** —
agent + human onboarding: `pnpm check` / `pnpm verify`, where each config lives, how to **add a new
gate** (script → `check` → CI step), commit convention, local-hook setup.

## 6. Dependencies Added (root `devDependencies`)

| Package | Why |
|---|---|
| `eslint`, `@eslint/js`, `typescript-eslint`, `globals` | flat-config ESLint over TS |
| `markdownlint-cli2` | docs lint |
| `@commitlint/cli`, `@commitlint/config-conventional` | commit enforcement |
| `simple-git-hooks` | local `commit-msg` hook |

`typescript` / `vitest` / `@types/node` already live in each package — root `typecheck` runs via
`pnpm -r` using the packages' own toolchains; no duplication.

## 7. Files Touched

**Create:** `eslint.config.mjs`, `.markdownlint.json`, `commitlint.config.mjs`, `.nvmrc`,
`.mcp.json`, `skill/work-with-pr/SKILL.md`, `skill/harness/SKILL.md`

**Edit:** root `package.json` (engines + scripts + devDeps + `simple-git-hooks`),
`packages/{autopilot,dynamic-workflows,permission-policy}/package.json` (`typecheck` ×3),
`.github/workflows/ci.yml` (rewrite), `CONTRIBUTING.md` (Harness section)

## 8. Verification (end-to-end)

1. `pnpm install` → installs deps **and** the `commit-msg` hook via `prepare`.
2. `pnpm check` → eslint + markdownlint + typecheck all green. *(If a package has latent type
   errors previously hidden by "CI never runs tsc", fix root-cause before enabling the gate.)*
3. `pnpm -r test` green; `pnpm verify` green (includes `docs:build`).
4. `git commit -m "bad message"` → **blocked** by the local hook; `git commit -m "feat: add x"`
   → passes.
5. Push a PR → CI runs `lint` + `typecheck` + `commitlint` + `test`; all green; each job writes a
   summary.
6. Reload MCP → codegraph tools available in-repo from `.mcp.json`.
7. `work-with-pr` and `harness` skills discoverable.

## 9. Rollout Order

Phase 1 (typecheck + eslint + `pnpm check`) → Phase 2 (markdownlint + commitlint + hook) →
Phase 3 (CI rewrite) → Phase 4 (`.mcp.json` + skills). Land incrementally; verify each phase's
gates pass before enabling the next, since Phase 1 may surface pre-existing type errors.
