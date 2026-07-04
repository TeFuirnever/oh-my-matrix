# ADR-015: Build Artifacts (`dist/`) Are Not Committed

## Status

Accepted (2026-07-04).

## Context

`packages/*/dist/` are TypeScript build artifacts (`tsc` output: `.js`, `.d.ts`, `.js.map`). All three workspace packages produce them:

- `packages/permission-policy/dist/` (16 files)
- `packages/dynamic-workflows/dist/` (24 files)
- `packages/autopilot/dist/` (80 files)

Historically these were committed to git at each package's extraction commit (`7e9cee4`, `26cdbc6`, `955921a`) and regenerated manually before each merge. A `.gitignore` rule (`packages/*/dist/`) was added in `5348c38` (2026-07-01) intending to stop committing them, but was never paired with `git rm --cached` — so the rule was dead code (tracked files override `.gitignore`) and 120 dist files remained in git.

This created the "stale dist silently undoes a source fix" hazard documented in #51 item 1: a contributor fixes a source bug, the test suite passes (it loads the freshly-rebuilt local dist), the PR merges — but if the committed dist wasn't regenerated and re-committed, consumers resolving to `dist/index.js` still run the buggy code. The source looks fixed; the shipped artifact is not.

## Decision

**`dist/` is not committed to git. It is regenerated from source whenever needed:**

- **CI** runs `pnpm -r build` before the `typecheck` and `test` jobs, so they exercise freshly-built artifacts. This also guarantees the dynamic-workflows test suite (which resolves `@oh-my-matrix/permission-policy` via a workspace symlink to `dist/index.js`) never silently runs against a stale built dist.
- **npm publish** runs `prepublishOnly: pnpm run build` (already present on all three packages), so the published tarball always carries a fresh dist.
- **Local development** requires `pnpm -r build` after `git clean` or a fresh clone before running tests/typecheck. (A `pretest`/`pretypecheck` convenience hook is intentionally NOT added — it would hide the build dependency and slow the common edit-test loop.)

## Consequences

**Positive:**
- Source is the single source of truth; no stale-dist regression is possible.
- PR diffs are clean — no compiled-artifact noise drowning out source changes.
- The existing `.gitignore` rule finally takes effect (it was dead code before).
- The dynamic-workflows stale-dist test hazard (issue #51 item 1 bonus finding) is eliminated.

**Negative:**
- Fresh clones and `git clean -fd` require an explicit `pnpm -r build` before tests/typecheck pass. This is documented in CONTRIBUTING and is the standard pnpm workspace convention.
- No "zero-build" checkout for inspection of compiled output — run `pnpm -r build` locally if needed.

## Alternatives Considered

- **Keep dist committed + add a `git diff --exit-code` CI gate** (issue #51 item 1 original proposal). This would catch stale dist but keeps the bidirectional coupling and PR noise. Rejected in favor of removing the artifact entirely, since the npm publish + host-deploy chain never depends on the git-committed copy.

## Related

- Issue #51 item 1 (dist-freshness CI gate) — closed by untracking.
- `.gitignore` line 12 (`packages/*/dist/`) — now effective.
- [ADR-010](010-autopilot-source-hosting.md) — host consumes via npm package, not git dist.
- [host-deploy runbook](../runbooks/host-deploy.md) — host installs from npm registry.
