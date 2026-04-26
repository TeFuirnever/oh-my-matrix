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

See [Architecture Overview](architecture.md) for module details.

---

## Phase 1: Workflow Runtime（工作流运行时）

**Goal:** Make ralph/autopilot/team workflows production-usable with persistence, mutual exclusion, and pipeline orchestration.

**Priority:** High — blocks workflow usability

| Deliverable                           | Description                                                                                                    | Reference                                      | Status              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------- |
| Workflow transition guard（互斥守卫） | Enforce single active workflow mode at a time; reject `active=true` writes when another mode is already active | oh-my-codex `workflow-transition-reconcile.ts` | ✓ Done (2026-04-26) |
| Ralph persistence                     | Progress ledger（进度账本）and PRD management; enable resume across sessions                                   | oh-my-codex `ralph/persistence.ts`             | ✓ Done (2026-04-26) |
| Pipeline stage definitions            | Define autopilot stage sequence (analyze → plan → execute → verify); enable structured multi-step execution    | oh-my-codex `pipeline/orchestrator.ts`         | Pending             |

**Exit criteria:**

- [x] Only one of ralph/autopilot/team can be `active=true` at any time
- [x] Ralph can resume from persisted state after session restart
- [ ] Autopilot executes a multi-step plan with per-step verification
- [x] All existing tests continue to pass + new tests for transition guard

**Estimated scope:** ~5-8 new files, ~500-800 lines

---

## Phase 2: Extended MCP（扩展 MCP 服务器）

**Goal:** Add memory and trace MCP servers for richer workflow context.

**Priority:** Medium — enhances workflow quality but not blocking

| Deliverable       | Description                                                                  | Reference              |
| ----------------- | ---------------------------------------------------------------------------- | ---------------------- |
| Memory MCP server | Persistent key-value memory store（持久化记忆存储）for cross-session context | oh-my-codex memory MCP |
| Trace MCP server  | Execution trace recording and querying（执行轨迹记录）                       | oh-my-codex trace MCP  |

**Exit criteria:**

- [ ] Memory MCP: read/write/list/delete operations over stdio
- [ ] Trace MCP: record execution events, query by session/time range
- [ ] Both servers follow zero-dependency pattern ([ADR-003](adr/003-zero-dependency-mcp.md))
- [ ] Consumer integration updated (seed config, bundle manifest)

**Estimated scope:** ~4-6 new files, ~400-600 lines

---

## Phase 3: Polish and Extensibility（完善与扩展性）

**Goal:** Improve developer experience, add extensibility hooks, expand test coverage.

**Priority:** Low — quality-of-life improvements

| Deliverable            | Description                                                    | Reference                          |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------- |
| Hook plugin system     | Dynamic hook loading from `.omm/hooks/*.mjs`（动态钩子加载）   | oh-my-codex hook loader/dispatcher |
| Agent prompt library   | Reusable role prompts (planner, architect, executor, verifier) | oh-my-codex 33 agent prompt files  |
| Expanded test coverage | Integration tests, MCP server tests, edge case coverage        | Target 80%+ coverage               |

**Exit criteria:**

- [ ] Custom hooks can be loaded and dispatched at session lifecycle points
- [ ] At least 5 agent prompts available for common workflow roles
- [ ] Test coverage ≥ 80% across all packages

---

## Non-Goals（明确不做）

These are deliberately excluded based on architectural decisions:

| Feature                   | Reason                                           | ADR                                           |
| ------------------------- | ------------------------------------------------ | --------------------------------------------- |
| Standalone CLI            | OpenClaw Gateway provides tool dispatch          | [ADR-001](adr/001-pure-plugin-no-cli.md)      |
| tmux/worktree parallelism | Host provides team primitives                    | [ADR-002](adr/002-team-delegation-to-host.md) |
| HUD / status bar          | Host UI layer (Electron) provides equivalent     | N/A                                           |
| Notification subsystem    | Host (MatrixAssistant) has its own notifications | N/A                                           |
| Rust native crates        | Not needed for plugin-only architecture          | [ADR-001](adr/001-pure-plugin-no-cli.md)      |
| Code-intel MCP            | OpenClaw may provide LSP integration natively    | N/A                                           |
