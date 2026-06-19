# ADR-009: Dynamic Workflows via OpenProse

## Status

Accepted (2026-06-18)

## Context

oh-my-matrix v0.6.0 reset the repo to docs-only, with `team` orchestration as the stated direction ([ADR-008](008-delegation-to-host.md)). The new direction is to deliver **dynamic workflows** for OpenClaw — multi-agent orchestration where the AI autonomously generates and executes workflow scripts, modeled after Claude Code's dynamic workflows feature.

### Decision journey (v1→v8)

The design went through 8 versions and 4 technical pre-research experiments:

- **v1–v5**: Attempted to build a custom JS runtime (loader/primitives/scheduler) with `agent()` backed by OpenClaw's `api.runtime.subagent`. Multiple rounds of adversarial review (3-person Claude panel + 2 Codex sessions with source-code access) identified that while the subagent API is viable (`types.ts:78-97`, `server-plugins.ts:452-534`), building a full runtime duplicates existing infrastructure.
- **v6**: Reframed from "script runtime" to "AI autonomous orchestration" after discovering Claude Code's dynamic workflows are AI-generated (not user-written). Still proposed a custom JS runtime.
- **v6 review**: Three-person adversarial panel challenged: "OpenProse already does this — why build a new runtime?"
- **v7**: Entered technical pre-research to answer "what level of infrastructure is needed?"
- **v8**: Pre-research concluded. Route B selected.

### Pre-research evidence (E1–E4)

| Experiment | Finding |
|---|---|
| E1 (prompt ceiling) | Pure prompt + `sessions_spawn` degrades at ~5–8 agents — insufficient for Claude Code scale (tens to hundreds) |
| E2 (OpenProse boundary) | **8/8 orchestration patterns fully covered** (fan-out, pipeline, adversarial-verify, loop-until-dry, routing, tournament, generate-and-filter, duel-loop). Includes recursive blocks, AI-evaluated conditionals, pipeline operators, pairwise analysis, error handling, parallel strategies, state backends, compiler validation, 49 examples, and a `workflow-crystallizer` that already generates .prose from natural language |
| E3 (subagent contract) | `api.runtime.subagent` is viable and awaitable — but OpenProse already uses `sessions_spawn` which serves the same purpose |
| E4 (registerTool model) | `registerTool` works but blocks the agent turn — acceptable for v1 but not needed since OpenProse already provides the runtime |

## Decision

**Deliver dynamic workflows as a SKILL.md package that teaches OpenClaw agents to generate `.prose` programs and execute them via OpenProse** (route B). Do not build a custom JS runtime.

### Rationale

1. **OpenProse is already bundled with OpenClaw** — zero additional runtime code needed.
2. **8/8 orchestration patterns covered** — no capability gap requiring a custom runtime.
3. **.prose is simpler than JS for AI generation** — no `export const meta`, no thunk syntax, no `.filter(Boolean)` pitfalls; markdown-first DSL with compiler validation.
4. **10x scope reduction** — ~200–500 lines of markdown vs ~3000–5000 lines of TypeScript.
5. **`workflow-crystallizer.prose`** already demonstrates the "natural language → .prose" pattern.

### What this supersedes

- v0.6.0's `team` orchestration direction (ADR-008).
- v1–v6's custom JS runtime proposals.

### What this preserves

- `api.runtime.subagent` findings (E3) — available as a future direct-dispatch path if needed.
- `registerTool` findings (E4) — available if a dedicated `workflow` tool is later justified.
- OpenProse's existing infrastructure — no modification to upstream.

## Consequences

- oh-my-matrix ships a **skill package**, not a runtime package.
- The skill depends on OpenProse being enabled (`openclaw plugins enable open-prose`).
- `docs/architecture.md`, `docs/roadmap.md`, `CONTEXT.md`, `README.md` updated to reflect the dynamic-workflows direction.
- Pre-research reports preserved at `.omc/specs/E{1-4}-*.md` and `.omc/specs/route-decision.md`.
