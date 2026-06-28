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

## Workflow

### Planning & Risk

- This repository is **documentation & design first**. It also hosts the canonical `@openclaw/autopilot` source at `packages/autopilot/` (a pnpm workspace package; see [ADR-010](docs/adr/010-autopilot-source-hosting.md)). The v0.x OpenClaw plugin / MCP implementation has been removed and its design records archived under `docs/archive/`.
- `packages/autopilot/` is **hosted** source (ADR-010), not an omm deliverable. After source changes run `pnpm --filter @openclaw/autopilot test`, then `./packages/autopilot/scripts/sync-to-ma.sh` to rebuild, refresh MA's tgz, install, and rebuild the claw-plugin copy the Gateway loads.
- Changes to the **subagent runtime guard** (`permission-policy` / `dynamic-workflows` / `autopilot` before_tool_call) ship via `./scripts/sync-to-ma.sh` (builds all 3 + cp dist into MA); verify the deployed dist with `node scripts/verify-guard.cjs` before restarting MA. See `docs/fixes/runtime-guard-event-shape.md`.
- Use the active planning workflow for non-trivial doc work, structural changes, or anything spanning multiple moving parts.
- If new evidence invalidates the current approach, stop and re-plan instead of forcing the original path through.
- Treat these as high-risk and apply stronger review:
  - **Spine docs** (`CONTEXT.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/adr/`) — the live, forward-looking surface; edits here reshape the project's stated direction.
  - **`docs/archive/` integrity** — historical design records; preserve as-is and do not rewrite history. Internal links may be stale **by design** (see `docs/archive/README.md`).

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
