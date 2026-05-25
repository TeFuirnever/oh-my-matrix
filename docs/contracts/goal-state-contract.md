# Goal State Contract

> Defines phase set, transition rules, subgoal semantics, gate validation, and audit trail for goal mode.
>
> Goal mode is a multi-instance abstraction independent of workflow modes (ralph/autopilot/team). Goals describe *what* to achieve; workflow modes execute *how*. Goals do not participate in workflow exclusivity.

## Overview

| Dimension | Goal Mode | Workflow Modes |
|-----------|-----------|----------------|
| Instances | Multi (any number of concurrent goals) | Singleton (one of each mode) |
| Storage | `{stateRoot}/goal/{goalId}.json` | `{stateRoot}/state/{mode}.json` |
| Exclusivity | Exempt (coexists with workflows) | Enforced (one active at a time) |
| Status field | `current_phase` | `status` (ralph, autopilot) / `current_phase` (team) |
| Audit trail | `goal/{goalId}.ledger.jsonl` | None |
| Mode discriminator | `mode: "goal"` | `mode: "ralph" | "autopilot" | "team"` |

## Phase Set

```
created → in_progress → validating → complete | failed | blocked
```

| Phase | Active | Description |
|-------|--------|-------------|
| `created` | `true` | Goal defined; subgoals may be drafted; not yet executing |
| `in_progress` | `true` | Actively working subgoals |
| `validating` | `true` | All non-blocked subgoals complete; verifying completion gates |
| `complete` | `false` | All critical subgoals pass gates (terminal: success) |
| `failed` | `false` | One or more critical subgoals failed (terminal: failure) |
| `blocked` | `false` | Externally blocked — dependency unavailable, waiting for input (terminal: blocked) |

**Key design choice:** Paused or suspended goals use `blocked` + `active=false`. This distinguishes them from actually-running goals (`active=true`). The earlier design of "paused = in_progress + active=true" was semantically broken — `active=false` correctly signals that no agent should be working on the goal.

## Phase Transitions

### Allowed via `updateGoal`

```
created ↔ in_progress ↔ validating
```

`updateGoal` may freely transition between non-terminal phases. Direct transitions into terminal phases (`complete`, `failed`, `blocked`) are **rejected** with `OMM_E_GOAL_TERMINAL`.

### Allowed via `completeGoal`

```
created | in_progress | validating → complete
created | in_progress | validating → failed
created | in_progress | validating → blocked
```

Only `completeGoal` can set terminal phases. It stamps `RunOutcome` (with `mode: "goal"`) and sets `active=false`, `completedAt`.

## State Structure

```typescript
interface GoalState {
  [key: string]: unknown;
  mode: "goal";
  active: boolean;
  goalId: string;
  current_phase: GoalPhase;
  goal: string;
  subgoals: Subgoal[];
  startedAt?: string;       // ISO8601, auto-set when active=true first written
  completedAt?: string;     // ISO8601, auto-set when terminal phase reached
  lastUpdatedAt?: string;   // ISO8601, every write
  outcome?: RunOutcome;     // stamped by completeGoal
}

interface Subgoal {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "blocked" | "complete" | "failed";
  order: number;            // v0.1: execution order (ascending, unique per goal)
  critical: boolean;        // default true; non-critical subgoals don't block completion
  dependsOn: string[];      // v0.1: referential integrity only (all IDs must exist)
  gate: CompletionGate;
  assignedMode?: "ralph" | "autopilot" | "team" | "manual";
}

interface CompletionGate {
  type: "manual" | "test_pass" | "file_exists" | "command_success" | "custom";
  description: string;
  criteria: string[];
  verified: boolean;
  verifiedAt?: string;      // ISO8601, auto-set when verified=true first written
  evidence?: string[];
}
```

## Field Size Limits

| Field | Limit | Error on Violation |
|-------|-------|--------------------|
| `goal` (top-level description) | 8,192 chars | `OMM_E_GOAL_TOO_LARGE` |
| `subgoals[]` | 100 entries | `OMM_E_GOAL_TOO_LARGE` |
| `Subgoal.description` | 4,096 chars | `OMM_E_GOAL_TOO_LARGE` |
| `Subgoal.dependsOn[]` | 20 entries | `OMM_E_GOAL_TOO_LARGE` |
| `CompletionGate.description` | 4,096 chars | `OMM_E_GOAL_TOO_LARGE` |
| `CompletionGate.criteria[]` | 20 entries, each ≤ 512 chars | `OMM_E_GOAL_TOO_LARGE` |
| `CompletionGate.evidence[]` | 50 entries, each ≤ 1,024 chars | `OMM_E_GOAL_TOO_LARGE` |

## Evidence Path Validation

Each `evidence` entry must pass:
- No `..` (path traversal)
- No absolute paths (`/` prefix or `C:\` drive letter)
- No shell metacharacters
- Pattern: `/^[a-z0-9_\-./@]{1,1024}$/i`

## Anti-Placeholder Gate Validation (B6)

When `verified=true`, at least one `evidence` entry must be non-empty and not a placeholder:

```
Rejected placeholders: TODO, TBD, placeholder, xxx, ..., ...
```

Enforced in `validateGoal()`. Modeled on OMX's `assertGoalWorkflowCanComplete()`.

## goalId Sanitization Contract (B2)

Every public function accepting `goalId` MUST call `sanitizeStateKey(goalId)` before any filesystem operation.

- **Pattern:** `KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i` (reused from `omm-state.ts`)
- **Rejection:** `OMM_E_GOAL_ID_INVALID`

This is non-negotiable — hand-rolled validation would diverge from the proven pattern and risk path traversal.

## Safe Write Contract (B1)

All cross-process write operations follow the lock→re-read→merge→validate→write order:

```
1. sanitizeStateKey(goalId)     — B2: validate before any I/O
2. withCrossProcessLock(...)     — acquire per-goal exclusive lock
3.   readGoalFile(goalId)        — re-read UNDER lock (prevents TOCTOU)
4.   deepMerge(current, patch)  — merge against fresh read
5.   validateGoal(merged)        — validate merged state
6.   atomicWrite(tmp+rename)     — safe persistence
7.   appendLedger(...)           — audit trail (B5)
```

This prevents lost updates in concurrent scenarios. Compare with `runOmmStateWrite` in `omm-state.ts:137` which performs all mutation inside the lock.

## Completion Logic

### isGoalComplete(state)

Returns `true` when **all critical subgoals** pass their completion gates. Non-critical subgoals are ignored for completion determination (B8).

### isGoalFailed(state)

Returns `true` when **any critical subgoal** has `status=failed`.

### Partial Failure Model (B8)

`Subgoal.critical: boolean` (default `true`):
- **Critical subgoal fails** → goal cannot complete (`isGoalFailed = true`)
- **Non-critical subgoal fails** → goal can still complete if all critical subgoals pass
- All subgoals (critical and non-critical) are subject to the same gate evidence validation

## Audit Ledger (B5)

Append-only JSONL at `{stateRoot}/goal/{goalId}.ledger.jsonl`. One line per state mutation:

```jsonl
{"event":"create","goalId":"my-goal","timestamp":"2026-05-25T12:00:00.000Z"}
{"event":"phase_transition","goalId":"my-goal","from":"created","to":"in_progress","timestamp":"2026-05-25T12:01:00.000Z"}
{"event":"subgoal_update","goalId":"my-goal","subgoalId":"sg-1","from":"pending","to":"complete","timestamp":"2026-05-25T12:05:00.000Z"}
{"event":"complete","goalId":"my-goal","outcome":"completed","reason":"all gates passed","timestamp":"2026-05-25T12:10:00.000Z"}
{"event":"delete","goalId":"my-goal","force":true,"lastPhase":"in_progress","timestamp":"2026-05-25T12:15:00.000Z"}
```

### Event Types

| Event | Trigger |
|-------|---------|
| `create` | `createGoal()` |
| `phase_transition` | `updateGoal()` with phase change or `completeGoal()` |
| `subgoal_update` | `updateGoal()` with subgoal status change |
| `complete` | `completeGoal()` — terminal outcome |
| `delete` | `deleteGoal()` — tombstone entry |

### Properties
- Best-effort: missing ledger entry does not invalidate canonical state
- Line-addressable: JSONL enables O(1) last-N reads via file seek
- Append-only: `fs.appendFile` with trailing newline; no in-place edits

## Resumption Support (B7)

### listActiveGoals()

Returns all goals with `active=true`. Enables session restart discovery.

### buildGoalHandoff(goalId)

Produces a structured string for deterministic resume context:

```
Goal: <goal description>
Phase: created | Active: true
Progress: 2/5 subgoals complete
Next: [3] Implement user authentication
Last updated: 2026-05-25T12:05:00.000Z
Ledger: <path>/goal/my-goal.ledger.jsonl
```

Exposed via `omm_goal_handoff` tool.

## Tool API

| Tool | Purpose | Requires Lock |
|------|---------|---------------|
| `omm_goal_write` | Create a new goal | Yes |
| `omm_goal_update` | Update an existing goal (non-terminal phases only) | Yes |
| `omm_goal_read` | Read a goal by ID | No |
| `omm_goal_list` | List all goals, optionally filter `activeOnly` | No |
| `omm_goal_delete` | Delete a goal (refuses active unless `force`) | Yes |
| `omm_goal_handoff` | Generate structured handoff for resumption | No |

## MCP Resource

```
omm://goal/<goalId> → reads goal/{goalId}.json
```

- **v0.1**: Read-only
- **v0.2 (planned)**: Write support
- **Defense-in-depth**: URI regex capture group is re-validated with `assertSafeKey()` before path construction

## Error Codes

| Code | When |
|------|------|
| `OMM_E_GOAL_ID_INVALID` | goalId fails `sanitizeStateKey()` |
| `OMM_E_GOAL_ACTIVE` | Attempted to delete active goal without `force` |
| `OMM_E_GOAL_TOO_LARGE` | Exceeded subgoal count or field size limits |
| `OMM_E_GOAL_TERMINAL` | `updateGoal` attempted terminal phase transition |
| `OMM_E_GOAL_NOT_FOUND` | goalId does not exist |

## File Permissions

Goal state files are written with `mode: 0o600` to prevent world-readable exposure of planning data.

## Exclusivity Exemption

Goal mode does not participate in workflow exclusivity. A goal may be active simultaneously with ralph, autopilot, or team. The workflow exclusivity guard in `omm-workflow-guard.ts` checks only `ralph`, `autopilot`, and `team` — goal files in the separate `goal/` directory are never scanned.

## Deferred to v0.2

| Feature | v0.1 Status |
|---------|-------------|
| Subgoal DAG (cycle detection, topological sort) | Ordered list with `order: number` |
| ManagedTaskFlow shadow sync | Not implemented |
| Automated gate verification (test_pass, command_success) | Gates are manual-only |
| MCP goal write support | Read-only |
| Goal reconciliation with platform snapshot | Not implemented |
| `omm_goal_delegate` (atomic check+start) | Not implemented |

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2026-05-25 | 0.1 | Initial contract — 5 phases, ordered subgoals, filesystem-only, audit ledger |
