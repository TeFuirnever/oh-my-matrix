# ADR-008: Delegation of Autonomous-Loop and Goal Capabilities to Host

## Status

Accepted, 2026-06-16.

## Context

omm was originally designed as a three-mode workflow state machine — `ralph` (iterative convergence loop), `autopilot` (autonomous multi-step pipeline), and `team` (multi-agent delegation) — plus a planned `goal` mode for multi-instance intent tracking ([ADR-004](004-three-mode-state-machine.md), [ADR-007](007-goal-mode.md)). The three modes shared a single validation dispatcher, exclusivity guard, and terminal-phase enforcement.

After ADR-004/007 were accepted, the host (MatrixAssistant, MA) shipped its own `@openclaw/autopilot` plugin (v2.0.0, `resources/claw-plugin/autopilot/`). This plugin **simultaneously covers** the responsibility surface of all three omm capabilities being considered for removal:

- **Continuous execution** (omm's `autopilot`) — MA autopilot provides a stage-driven pipeline with per-step verification, retry, and blocking semantics.
- **Iterative convergence** (omm's `ralph`) — MA autopilot's stall-detector + goal_manager combination provides the iterative-plan-fix loop with persisted ledger and resume.
- **Goal tracking** (omm's planned `goal` mode, ADR-007) — MA autopilot ships a built-in `goal_manager` with multi-instance goal state, subgoal decomposition, evidence gates, and audit persistence.

The MA autopilot plugin is more mature than omm's corresponding code: it registers 11 hooks, ships a full `AutopilotDashboard` UI, has an independent test matrix and build pipeline, and is already integrated into MA's release surface.

Meanwhile, omm's remaining responsibility — `team` orchestration plus the planned **digital-employee bridge** (letting `team` schedule and dispatch MA's digital employees) — is a capability MA's autopilot does **not** provide. This is omm's core incremental value over the host.

## Decision Drivers

1. **ADR-002 (delegate to host)**: omm should not rebuild capabilities the host already provides. This principle already governed `team` (delegated parallel execution to host primitives); the same logic applies to autonomous loops.
2. **MA autopilot is more mature**: 11 hooks, dashboard UI, full test matrix, independent build. omm's ralph/autopilot code was a thinner reimplementation.
3. **Avoid duplicate maintenance**: Keeping omm's ralph/autopilot would mean two competing autonomous-loop engines in the same host stack, doubling bug surface and drift risk.
4. **Focus omm on its unique increment**: omm's core value is `team` orchestration + the digital-employee bridge (scheduling MA employees from a team plan). MA autopilot has no equivalent. Concentrating effort here maximizes omm's marginal value.
5. **Goal mode never shipped in omm**: ADR-007 was a planning decision; no goal code was released. With MA autopilot's `goal_manager` available, implementing it in omm would be pure duplication.

## Decision

**Delete omm's `ralph`, `autopilot`, and planned `goal` capabilities. Delegate autonomous-loop and goal tracking to the MA host's `@openclaw/autopilot` plugin. omm converges to a single workflow mode: `team`.**

### What was removed (2026-06-16)

- **Code**: `omm-autopilot-pipeline.ts`, `omm-ralph-store.ts`, `omm-goal-state.ts`, `omm-goal-ledger.ts`, `omm-tools/omm-goal.ts`, and related validators/guards.
- **Skills**: `omm-skills/omm-ralph/`, `omm-skills/omm-autopilot/`, `omm-skills/omm-ralplan/` deleted. `SHIPPED_SKILLS` reduced to `["omm-ping", "omm-cancel", "omm-team"]`.
- **Plugin tools**: All six `omm_goal_*` tools removed. The plugin now registers **7 tools**: `omm_ping`, `omm_cancel`, `omm_state_write`, `omm_state_read`, `omm_state_list`, `omm_agent_prompt_get`, `omm_agent_prompt_list`.

> **v0.5.0 update (2026-06-16):** Further reduced to **5 tools** (`omm_state_write`, `omm_state_read`, `omm_employee_list`, `omm_employee_dispatch`, `omm_employee_result`). `omm_ping`, `omm_cancel`, `omm_state_list`, `omm_agent_prompt_get`, and `omm_agent_prompt_list` were removed from plugin registration. Agent prompts remain accessible via MCP Prompts catalog.
- **State machine**: `omm-state-validation.ts`, `omm-workflow-guard.ts`, `omm-mode-lifecycle.ts`, `omm-run-outcome.ts`, and `omm-types.ts` collapsed to single-mode `team` only. The exclusivity guard now only recognizes `team` as a workflow key.

### What was kept

- **`team` mode** (single workflow mode) — team orchestration via host primitives ([ADR-002](002-team-delegation-to-host.md)).
- **Agent persona library** (19 prompts) — still consumed by `team` orchestration; the personas are reusable.
- **State, memory, and trace MCP servers** — unchanged.
- **Lifecycle hooks, build toolchain, compliance scripts** — unchanged.

### Agent anchor remapping

Agents previously anchored to `omm-autopilot` or `omm-ralplan` are re-anchored to `omm-team` (the surviving workflow skill), since `team` orchestration still needs the personas. The autonomous-loop capability those skills provided is now delegated to MA autopilot.

## Consequences

**Positive:**

- **Single source of truth for autonomous loops**: MA autopilot is the only autonomous-loop engine in the stack. No drift between two implementations.
- **Simpler omm state machine**: One workflow mode (`team`) means a single validator path, a trivial exclusivity guard, and no cross-mode transition edge cases.
- **Smaller shipped surface**: 3 skills and 7 tools (down from 5 skills and 13 tools), reducing the MA integration testing matrix.
- **Clear division of labor**: omm owns team orchestration + employee bridging; MA owns autonomous loops + goal tracking. Each side owns what it does best.

**Negative:**

- **Host dependency for autonomous loops**: omm alone can no longer run an autonomous fix-until-green loop. Hosts without MA autopilot lose that capability. This is acceptable — omm targets MA-class hosts.
- **Agent persona anchors lose their original skill binding**: Agents like `executor`/`debugger` (formerly `omm-autopilot`) and `planner`/`critic`/`analyst`/`architect` (formerly `omm-ralplan`) are re-anchored to `omm-team`. The personas are still loaded; only the dispatch entry point changed.
- **ADR-007 goal work is parked**: The filesystem-canonical goal design in ADR-007 is superseded. If MA autopilot's goal_manager proves insufficient, the design remains a reference, but re-implementing it in omm is not currently planned.

## Follow-ups

1. **Digital-employee bridge**: Implement an omm tool + skill that lets `team` schedule and dispatch MA's digital employees from a decomposed plan. This is omm's primary post-convergence deliverable. See `docs/specs/omm-ma-employee-bridge-spec.md`.
2. **Non-core skills removed**: Following this ADR, all non-core skill directories (deep-interview, ultrawork, ultraqa, docs, ui, git, research, refactor) were deleted outright rather than left parked — omm ships only `omm-ping` / `omm-cancel` / `omm-team`. They remain recoverable from git history if a workflow skill is needed again.
3. **MA autopilot contract documentation**: Document the MA autopilot plugin's hook surface and goal_manager API from omm's consumer perspective, so `team` + employee-bridge can interact with it cleanly.

## Related ADRs

- **ADR-002**: Team delegation to host — same delegation principle, applied earlier to parallel execution.
- **ADR-004**: Three-mode state machine — superseded by this ADR for the mode-set decision; the shared-validation design is retained for the surviving `team` mode.
- **ADR-007**: Goal mode — superseded. Goal tracking delegated to MA autopilot `goal_manager`.

## Review History

| Date       | Event                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 2026-06-16 | MA autopilot v2.0.0 audit confirmed it covers ralph + autopilot + goal responsibility surfaces.          |
| 2026-06-16 | Decision accepted: delete omm ralph/autopilot/goal, delegate to host, converge to single-mode `team`.    |
