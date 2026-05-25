# omm Development Roadmap

> Current: v0.4.2 — Phase 1-4 automated release surface shipped; human MA confirmation pending

## Current State Summary

omm now ships the local workflow/runtime foundation and consumer integration helpers:

- **5 tools** registered via OpenClaw Plugin ABI
- **14 packaged skills** copied to both suite and OpenClaw plugin roots
- **3 MCP servers** for state, memory, and trace access
- **State validation** for ralph/autopilot/team modes
- **411 tests** passing, CI pipeline operational
- **Compliance and consumer-seed toolchain** (scan-names, generate/verify inlines, verify-bundle, verify-provenance, smoke-mcp, MA/OpenClaw seeders)

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

## Phase 4: Agent Library Expansion + MCP Capability Surface

**Goal:** Broaden agent persona coverage to match the core development lifecycle, and expose richer omm telemetry through standard MCP channels for downstream UI consumers.

**Priority:** Medium — unlocks UI integration and lifecycle coverage

| Deliverable                         | Description                                                        | Status                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Agent prompt expansion              | Port planning, tracing, review, debugging, and exploration prompts | Done (2026-05-08) — 16 total agents                                                          |
| Claude-only token strip-check in CI | Prevent upstream-only semantic tokens from leaking into prompts    | Done (2026-05-08)                                                                            |
| MCP Resources advertisement         | Expose state and trace resources                                   | Done (2026-05-08) — `omm://state/<key>` and `omm://trace/<sessionId>`                        |
| MCP Prompts advertisement           | Expose agent prompts through MCP                                   | Done (2026-05-08)                                                                            |
| Progress notifications verification | Confirm MA support for `notifications/progress`                    | Done (2026-05-08) — deferred because MA self-audit marks progress notifications unsupported  |
| omm-docs skill                      | Documentation generation pipeline                                  | Done (2026-05-08) — bundled by suite builder                                                 |
| omm-ui skill                        | UI artifact generation pipeline                                    | Done (2026-05-08) — bundled by suite builder                                                 |
| P2 agent porting                    | Port git-master, scientist, code-simplifier                        | Done (2026-05-13) — 19 total agents; `omm-git`, `omm-research`, `omm-refactor`               |

**Exit criteria:**

- [x] Agent inventory ≥ 15 with skill anchors documented
- [x] CI strip-check enforces no upstream-only token regressions
- [x] MCP Resources advertised by at least one omm MCP server
- [x] MCP Prompts advertised by omm-mcp
- [x] Automated MA-consumer wire-contract roundtrip passes
- [ ] Human-side confirmation: seeded servers appear with Resources/Prompts in MA's MCP catalog UI

**Remaining external validation:** human-side MA confirmation that the seeded servers appear with Resources/Prompts in MA's MCP catalog UI.

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
