---
name: work-with-pr
description: "Full PR lifecycle for oh-my-matrix in a task-owned git worktree — implement with evidence-bound QA, open a reviewer-readable PR against `master`, then run an unbounded verify loop over three gates (CI / review-work / docs-build) until all pass, then merge by default and clean up the worktree. Decomposes work into the smallest atomic, independently-mergeable PRs and builds the independent ones concurrently. Use whenever implementation work needs to land as a PR. Triggers: 'create a PR', 'implement and PR', 'land this', 'work-with-pr', 'implement issue', 'split into atomic PRs', 'parallel PRs', even 'implement X' when the context implies PR delivery."
---

# Work With PR — OMM PR Lifecycle

You execute a complete PR lifecycle: fresh task-owned worktree → implement with evidence-bound QA → reviewer-readable PR against `master` → unbounded verification loop → merge by default → worktree cleanup. A failing gate sends you back into the worktree to fix and re-QA. You keep cycling until every active gate passes at once.

**The unit of delivery is the smallest PR that compiles, passes, and stands on its own** — not "one task, one PR." A single task routinely splits into several atomic PRs; apply the lifecycle below to each, and build the independent ones concurrently.

<architecture>

```
Phase 0: Setup     → Split into atomic PRs; branch + worktree per PR (parallel when independent)
Phase 1: Implement → Run `pnpm verify` green locally; evidence-bound QA per success criterion; atomic commits
Phase 2: PR        → Push, open a reviewer-readable PR targeting `master`
Phase 3: Verify    → Unbounded loop; a failing gate routes back to Phase 1:
  ├─ Gate A: CI          → gh pr checks (lint + lint:md + typecheck + commitlint + test)
  ├─ Gate B: review-work → code-reviewer subagent pass (no unresolved high/🔴 findings)
  └─ Gate C: docs-build  → `pnpm docs:build` green (docs-first repo: never break the site)
Phase 4: Merge     → Merge by default; wait until actually merged; then worktree cleanup
```

</architecture>

## OMM invariants (non-negotiable)

- **Docs-first.** A PR that breaks `pnpm docs:build` (Gate C) is not mergeable, full stop.
- **Surgical changes only** (AGENTS.md). Don't refactor adjacent code/docs; every changed line traces to the PR's purpose.
- **Spine docs are high-risk** (`CONTEXT.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/adr/`). Touch them only when the PR's purpose is that change; otherwise leave them.
- **`docs/archive/` is frozen** — never rewrite history.
- `packages/autopilot` is hosted source (ADR-010); source changes need `pnpm --filter @oh-my-matrix/autopilot test` plus the internal host-deploy step — don't claim host deployment is done unless the dist was actually refreshed and smoke-tested.

## Phase 0 — Setup

1. **Decompose** the task into the smallest atomic PRs that each compile, pass, and deliver one reviewable slice. Sequence by dependency: independent slices branch off the base and run in parallel (one worktree each); dependent slices stack.
2. **Worktree isolation.** Create a fresh worktree per PR (the user's main dir is read-only context; a branch checkout there could destroy uncommitted work):
   ```bash
   git worktree add -b <branch> ../omm-<branch> master
   cd ../omm-<branch>
   pnpm install          # also installs the commit-msg hook via prepare
   ```
3. Branch off `master` (OMM's flow is PR→`master`, unlike oh-my-openagent's `dev`→`master`).

## Phase 1 — Implement

- Drive the work; gate yourself locally with **`pnpm verify`** (lint + markdownlint + typecheck + all workspace tests + docs build). Do not push until it's green.
- Evidence-bound QA: for each success criterion, produce concrete proof (a test, a command output, a doc rendered section) — not a claim.
- Atomic Conventional-Commit messages (`feat:`, `fix:`, `docs:`, …). The local `commit-msg` hook enforces the format; bad messages are rejected.

## Phase 2 — PR

- Push and open a reviewer-readable PR in English against `master`: what changed, why, how it was verified, and any risks/test notes (AGENTS.md §"After submitting code").

## Phase 3 — Verify loop

Run the gates together; any failure routes back to Phase 1 in this PR's worktree:

- **Gate A — CI.** `gh pr checks --watch <url>` → all green. CI jobs: `lint` (eslint + markdownlint), `typecheck`, `commitlint` (PR only), `test`.
- **Gate B — review-work.** Dispatch a `code-reviewer` subagent over the diff. Resolve every high/🔴 finding before merging; lower severities can be tracked as follow-ups but must be stated in the PR.
- **Gate C — docs-build.** `pnpm docs:build` green. If the PR touches docs, also confirm the rendered site is coherent.

No gate is "skipped because it's hard." If a gate is genuinely N/A (e.g. a code-only PR doesn't alter docs), say so explicitly in the PR rather than silently dropping it.

## Phase 4 — Merge

- Merge by default once all active gates are green and review-work is clear.
- Wait until the PR is **actually merged**, then remove the worktree: `git worktree remove ../omm-<branch>` (+ delete the branch if not already).

## Concurrency

Build independent atomic PRs concurrently — one background subagent per PR, each owning its worktree and running Phase 0→4. Dependent PRs stack sequentially.
