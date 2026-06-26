# ADR-004: Three-Mode State Machine with Shared Validation

> 🗄 **归档 / Archived** — v0.x OpenClaw 插件/MCP 实现的设计记录。代码已于 0.6.0 移除；本仓库现为文档/设计底座。内部链接可能已失效。

> **Status update (2026-06-16):** This ADR originally defined a **three-mode** state machine (`ralph` / `autopilot` / `team`). As of [ADR-008](008-delegation-to-host.md), the `ralph` and `autopilot` modes have been **deleted and delegated to the host** (MA's `@openclaw/autopilot` plugin). omm now ships a **single-mode** state machine: `team`.
>
> The text below is preserved as the historical record of the original decision. The shared-validation design (single dispatcher, terminal enforcement, default injection) is **retained** for the surviving `team` mode. All references to `ralph` and `autopilot` phase sets, counters, and validators now describe removed code — see ADR-008 for the convergence rationale and the current single-mode contract in [Workflow State Contract](../contracts/workflow-state-contract.md).

## Context

oh-my-codex validates ralph state via a dedicated contract (`ralph/contract.ts`) but does not have unified validation across workflow modes. omm originally supported three concurrent workflow modes — ralph, autopilot, and team — each with different phase sets, counters, and lifecycle rules.

Without validation, `omm_state_write` would accept arbitrary JSON, allowing invalid phase transitions, inconsistent counter values, and active workflows with terminal statuses.

## Decision

omm implements a **single validation dispatcher**（统一验证分发器）that routes to mode-specific validators:

```
validateStateWrite(key, value)
  → mode = value.mode ?? key
  → VALIDATORS[mode] → mode-specific validation
  → unknown mode → pass through with timestamp only
```

### Shared rules across all modes

- **Terminal phase enforcement**: phases in `{complete, failed, blocked}` require `active=false`; `completedAt` is auto-set if missing
- **Timestamp validation**: `startedAt`, `completedAt`, `lastUpdatedAt` must be valid ISO8601 when present
- **Phase normalization**: raw strings are trimmed and lowercased before validation
- **Default injection**: when `active=true` and fields are null, sensible defaults are injected (e.g., `iteration=0` for ralph)
- **Immutability**: validators work on a shallow copy (`{ ...candidate }`), never mutating the input

### Mode-specific phase sets

| Mode      | Phases                                                                            | Status Field    |
| --------- | --------------------------------------------------------------------------------- | --------------- |
| ralph     | init, planning, executing, verifying, fixing, complete, failed                    | `status`        |
| autopilot | analyzing, planning, executing, verifying, retry, complete, blocked, failed       | `status`        |
| team      | planning, decomposing, executing, verifying, fixing, delegating, complete, failed | `current_phase` |

### Mode-specific counters

| Mode      | Counters (defaults)                                                               |
| --------- | --------------------------------------------------------------------------------- |
| ralph     | `iteration` (0), `max_iterations` (10), `fix_attempt` (0), `max_fix_attempts` (3) |
| autopilot | `current_step` (0), `total_steps` (0), `max_retries_per_step` (3)                 |
| team      | `fix_loop_count` (0), `max_fix_loops` (3)                                         |

## Consequences

**Positive:**

- Single entry point for all state writes — consistent validation regardless of caller
- Unknown keys pass through safely — extensible without code changes
- Terminal rules prevent "zombie" workflows (active=true + complete status)
- Default injection reduces boilerplate in SKILL.md instructions

**Negative:**

- No workflow transition guard（缺少工作流互斥守卫）: ralph, autopilot, and team can all be `active=true` simultaneously. This was a known gap, later resolved by the exclusivity guard (see [Workflow State Contract](../contracts/workflow-state-contract.md)).
- Shallow validation only: validators check field types and phase membership, not transition legality (e.g., jumping from `init` directly to `complete` is allowed)
- Duplicated logic in MCP server: the MCP server inlines a simplified version of these validators

**Known gap (resolved):** A workflow transition reconciler was needed to enforce that only one workflow mode is active at a time. This was delivered as `assertWorkflowExclusivity()` in Phase 1. As of ADR-008, the guard now only recognizes `team` (the sole surviving workflow mode).

## Post-ADR-008 Convergence (2026-06-16)

Per [ADR-008](008-delegation-to-host.md), the three-mode design was collapsed to a single `team` mode. The shared-validation architecture from this ADR survives in simplified form:

- The single validation dispatcher still routes `team` writes to `validateTeam()`.
- Terminal-phase enforcement and timestamp/default injection remain.
- The `ralph` and `autopilot` validators and their phase sets/counter invariants have been deleted.
- The exclusivity guard now trivially enforces "at most one `team` active" — there are no other workflow modes to conflict with.
