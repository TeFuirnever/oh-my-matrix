---
name: omm-refactor
description: Behavior-preserving simplification pipeline - analyze, simplify, and verify recently modified code
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start a behavior-preserving refactor session.

> Lifecycle conventions (state init, agent loading, terminal markers) follow `docs/contracts/skill-lifecycle.md` §1. This skill uses the standard 3-phase pipeline from §2. State key: `refactor`.

## Usage

```
/omm-refactor <file|scope|recent-changes>
```

## Purpose

omm-refactor loads the `code-simplifier` prompt to remove avoidable complexity from scoped code while preserving behavior and verifying the result.

## Output Targets

| Target type | Output |
|-------------|--------|
| File path | Edited file plus verification summary |
| `recent-changes` | Scoped simplification of files from `git diff --name-only` |
| Custom scope | Caller-approved file list |

## Phase 1: Discover

Agent: `code-simplifier`.

Capture:

- Files in scope
- Existing tests and commands that cover the behavior
- Simplification candidates and skipped areas
- Behavior-preservation risks

## Phase 2: Generate

Agent: `code-simplifier`.

Apply only the smallest scoped edits that clearly preserve behavior. Prefer deletion and existing utilities over new abstractions. Do not refactor adjacent code for style-only reasons.

## Phase 3: Verify

Programmatic checks:

1. Run targeted tests for changed behavior.
2. Run lint/typecheck/build when shared helpers, generated artifacts, or public contracts were touched.
3. Inspect `git diff` to confirm the change is scoped and reviewable.
4. If behavior preservation is uncertain, revert the uncertain edit and mark the run blocked with the reason.

## Out-of-scope

- Feature work
- Public API redesign
- New dependencies
- Broad cleanup outside the requested scope
