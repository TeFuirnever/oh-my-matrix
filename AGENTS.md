<!-- Generated: 2026-04-13 | Updated: 2026-04-13 -->

# AGENTS.md

Instructions for AI agents working. All content in English.

> **Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## Scope & Precedence

- This file defines specific repository constraints only.
- General execution policy, planning, skills, model routing, and completion discipline follow the project's AGENTS.md and rules/ configuration.
- If runtime instructions and this file overlap, preserve the invariants below without reintroducing stale local workflow rules.
- **Priority when rules conflict:** project-specific rules below > general behavioral guidelines.

## Identity & Principles

- Address the user as **【Specialist】** in every response.
- **Think before coding** — if motivation, goal, or constraints are unclear, stop and clarify before acting. If multiple interpretations exist, state the assumption or tradeoff instead of choosing silently.
- **Push back when warranted** — if the proposed path is not the shortest, safest, or most effective, say so and recommend a better approach.
- **Minimum code, maximum clarity** — no features, abstractions, or "flexibility" beyond what was asked. Prefer small, focused functions; extract helpers when a function exceeds 50 lines.

**MUST DO:**

1. Clarify unclear requirements before implementation.
2. For bug fixes: reproduce the issue, add a failing or regression test first, then submit the fix.
3. For non-trivial work, define verifiable success criteria before implementation.
4. After submitting code: state potential risks + test recommendations.
5. All user-visible text MUST go through i18n; no hardcoded strings.

**Core Principles:**

- **Simplicity First** — minimal code impact, simplest possible change.
- **No Laziness** — find root causes, no temporary fixes, senior developer standards.
- **Surgical Changes Only** — every changed line should trace directly to the current task. Don't refactor adjacent code or "improve" formatting unless required.
- **No Speculation** — do not add abstractions, configuration, or future-proofing that the request does not need.
- **Verify Before Claiming Done** — evidence over assumptions.
- **Know When to Stop** — if blocked for more than 2 attempts on the same issue, or if requirements remain ambiguous after clarification, escalate to the user instead of guessing.
- **Trace Before Fix** — when debugging (especially concurrency or state-persistence issues), trace the FULL execution path from tool call to the persisted state file on disk, step by step. Do not propose architectural solutions based on assumptions. The simplest explanation (wrong phase, missing `active=false` on a terminal phase, a stale cross-process lock) should be checked first. See `docs/adr/005-cross-process-locking.md` for the concurrency model.

## Workflow

### Planning & Risk

- Use the active planning workflow for non-trivial tasks, architectural decisions, or work that spans multiple moving parts.
- If new evidence invalidates the current approach, stop and re-plan instead of forcing the original path through.
- Treat these areas as high-risk and apply stronger planning, review, and verification:
  - `omm-state-validation.ts` — phase/terminal/counter invariants for the `team` state machine
  - `omm-fs-queue.ts` — cross-process locking (ADR-005); a regression here causes silent last-write-wins
  - `omm-register.ts` — the plugin ABI; the 4-arg `execute(toolCallId, params, …)` shape (a 1-arg regression silently drops params, see CHANGELOG 0.2.2)
  - `omm-tools/omm-employee.ts` — the MA dispatch/result relay and its blocking poll semantics
  - `omm-build-suite.mjs` / `generate-mcp-inlines.mjs` — the zero-dep MCP inline pipeline (ADR-003/006)

### Change Discipline

- Match existing local style and patterns before introducing new structure.
- Do not refactor adjacent code, comments, or formatting unless the current task requires it.
- Remove dead code only when it is made obsolete by the current change. If unrelated cleanup is tempting, mention it separately.
- When your changes create orphans: remove imports/variables/functions that YOUR changes made unused. Don't remove pre-existing dead code unless asked.

### Bug Fixes

1. Reproduce the issue.
2. Add a failing or regression test.
3. Implement the minimal fix.
4. Verify tests pass.
5. State potential risks + test recommendations.

### Subagents & Lessons

- Use subagents when they materially improve correctness, speed, or parallelism on bounded work.
- Update `tasks/lessons.md` only when the work exposes a reusable policy, recurring failure mode, or repeatable workflow correction.

## Agent skills

### Issue tracker

Issues live as GitHub issues (`TeFuirnever/oh-my-matrix`). Use `gh` CLI for all operations. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles using default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo. `CONTEXT.md` at root (if it exists) + `docs/adr/` for architectural decisions. See `docs/agents/domain.md`.
