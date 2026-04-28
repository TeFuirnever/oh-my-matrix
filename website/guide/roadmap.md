# omm Development Roadmap

> Current: v0.2.0 — core skeleton complete, workflow runtime pending

## Current State Summary

omm covers ~15-20% of oh-my-codex's core functionality. The foundation is solid:

- **5 tools** registered via OpenClaw Plugin ABI
- **5 skills** defined (2 tool-dispatch, 3 model-driven state machines)
- **1 MCP server** for out-of-process state access
- **State validation** for ralph/autopilot/team modes
- **25 tests** passing, CI pipeline operational
- **Compliance toolchain** (scan-names, verify-bundle, verify-provenance)

See [Architecture Overview](/guide/architecture) for module details.

---

## Phase 1: Workflow Runtime

**Goal:** Make ralph/autopilot/team workflows production-usable with persistence, mutual exclusion, and pipeline orchestration.

**Priority:** High — blocks workflow usability

| Deliverable                | Description                                                                                                    | Status            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------- |
| Workflow transition guard  | Enforce single active workflow mode at a time; reject `active=true` writes when another mode is already active | Done (2026-04-26) |
| Ralph persistence          | Progress ledger and PRD management; enable resume across sessions                                              | Done (2026-04-26) |
| Pipeline stage definitions | Define autopilot stage sequence (analyze → plan → execute → verify); enable structured multi-step execution    | Done (2026-04-26) |

**Exit criteria:**

- [x] Only one of ralph/autopilot/team can be `active=true` at any time
- [x] Ralph can resume from persisted state after session restart
- [x] Autopilot executes a multi-step plan with per-step verification
- [x] All existing tests continue to pass + new tests for transition guard

---

## Phase 2: Extended MCP

**Goal:** Add memory and trace MCP servers for richer workflow context.

**Priority:** Medium — enhances workflow quality but not blocking

| Deliverable       | Description                                                 | Status            |
| ----------------- | ----------------------------------------------------------- | ----------------- |
| Memory MCP server | Persistent key-value memory store for cross-session context | Done (2026-04-26) |
| Trace MCP server  | Execution trace recording and querying                      | Done (2026-04-26) |

**Exit criteria:**

- [x] Memory MCP: read/write/list/delete operations over stdio
- [x] Trace MCP: record execution events, query by session/time range
- [x] Both servers follow zero-dependency pattern ([ADR-003](/reference/adrs/003))
- [x] Consumer integration updated (seed config, bundle manifest)

---

## Phase 3: Polish and Extensibility

**Goal:** Improve developer experience, add extensibility hooks, expand test coverage.

**Priority:** Low — quality-of-life improvements

| Deliverable            | Description                                                    | Status                                                                     |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Hook plugin system     | Dynamic hook loading from `.omm/hooks/*.mjs`                   | Done (2026-04-26)                                                          |
| Agent prompt library   | Reusable role prompts (planner, architect, executor, verifier) | Done (2026-04-26)                                                          |
| Expanded test coverage | Integration tests, MCP server tests, edge case coverage        | Done (2026-04-26) — 96.83% statements / 98.27% functions / 91.07% branches |

**Exit criteria:**

- [x] Custom hooks can be loaded and dispatched at session lifecycle points
- [x] At least 5 agent prompts available for common workflow roles
- [x] Test coverage ≥ 80% across all packages

---

## Non-Goals

These are deliberately excluded based on architectural decisions:

| Feature                   | Reason                                           | ADR                            |
| ------------------------- | ------------------------------------------------ | ------------------------------ |
| Standalone CLI            | OpenClaw Gateway provides tool dispatch          | [ADR-001](/reference/adrs/001) |
| tmux/worktree parallelism | Host provides team primitives                    | [ADR-002](/reference/adrs/002) |
| HUD / status bar          | Host UI layer (Electron) provides equivalent     | N/A                            |
| Notification subsystem    | Host (MatrixAssistant) has its own notifications | N/A                            |
| Rust native crates        | Not needed for plugin-only architecture          | [ADR-001](/reference/adrs/001) |
| Code-intel MCP            | OpenClaw may provide LSP integration natively    | N/A                            |
