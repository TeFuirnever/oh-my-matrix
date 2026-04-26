# ADR-004: Three-Mode State Machine with Shared Validation

## Context

oh-my-codex validates ralph state via a dedicated contract (`ralph/contract.ts`) but does not have unified validation across workflow modes. omm supports three concurrent workflow modes — ralph, autopilot, and team — each with different phase sets, counters, and lifecycle rules.

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

- No workflow transition guard（缺少工作流互斥守卫）: ralph, autopilot, and team can all be `active=true` simultaneously. This is a known gap planned for Phase 1.
- Shallow validation only: validators check field types and phase membership, not transition legality (e.g., jumping from `init` directly to `complete` is allowed)
- Duplicated logic in MCP server: the MCP server inlines a simplified version of these validators

**Known gap:** A workflow transition reconciler (like oh-my-codex's `workflow-transition-reconcile.ts`) is needed to enforce that only one workflow mode is active at a time. See [Roadmap Phase 1](../roadmap.md).
