---
name: omm-team
description: Multi-agent team orchestration with persona-aware dispatch, fork-join collection, and result synthesis
user-invocable: true
disable-model-invocation: false
version: 0.3.0
---

Start or resume an omm-team multi-agent execution pipeline.

## Usage

```
/omm-team <task description>
/omm-team N:agent-type <task description>
```

## Architecture

omm-team provides **state tracking and persona-aware orchestration** while delegating actual parallel execution to MA digital employees (via the state-file relay) or the host's native team skill as fallback. This avoids reimplementing worker spawning.

The orchestrator is a **pure coordinator**: it decomposes, dispatches, collects, and synthesizes. It does not produce content itself — every subtask goes to a specialized persona.

## Lifecycle

### Phase 1 — INIT

1. **Receive** user task description and optional `N:agent-type` parameter.
2. **Read state** via `omm_state_read` with `key=team`. If `active=true` and `current_phase` is non-terminal, resume from that phase.

   > **Important — interpreting `omm_state_read` responses**: when no state file exists yet, the tool returns the literal text `null`. **This is normal — it means "not started yet", not an error.** Do not retry. Proceed by initializing state.

3. **Write initial state** via `omm_state_write` with `key=team`:
   ```json
   {
     "mode": "team",
     "active": true,
     "task": "<original task>",
     "current_phase": "decomposing",
     "agent_count": 3,
     "fix_loop_count": 0,
     "max_fix_loops": 3,
     "startedAt": "..."
   }
   ```

### Phase 2 — DECOMPOSING (Persona-Aware Task Assignment)

1. **Detect available workers**: call `omm_employee_list`.
   - **Employees available**: proceed with persona-aware assignment (path A).
   - **No employees** (`employees: []`): fall back to host-native `Skill("team")` (path B) — skip to Phase 6.

2. **Path A — Assign each subtask a persona**: For each subtask, inspect the employee `roleId` (not `agentId`) and assign the best-matching persona. Reference the persona matrix:

   | Subtask type | Target roleId contains |
   |-------------|----------------------|
   | Design / architecture | `architect` |
   | Implementation / coding | `executor` |
   | Testing / verification | `verifier` |
   | Security review | `security-reviewer` |
   | Documentation | `writer` |
   | Debugging | `debugger` |
   | Requirements analysis | `analyst` |

3. **Persist the assignment**: write the full `subtasks` array to state immediately. Each entry:
   ```json
   {
     "id": "s1",
     "description": "implement auth module",
     "roleId": "executor",
     "assignedTo": "<agentId>",
     "status": "pending"
   }
   ```
   Storing `assignedTo`/`roleId` in state means you do NOT need to remember which employee handles which subtask — read it back from state on resume.

4. Transition: `current_phase = "delegating"`.

### Phase 3 — DELEGATING (Fork: Dispatch All)

Dispatch every pending subtask. **Dispatch all before collecting any** — this is the fork.

For each subtask in `subtasks`:
1. Call `omm_employee_dispatch({ agentId: subtask.assignedTo, message: subtask.description })`.
2. **Immediately** write the returned `runId` back into the subtask via `omm_state_write`:
   ```json
   { "subtasks": [ { "id": "s1", ..., "runId": "<returned-runId>", "status": "dispatched" }, ... ] }
   ```
   > Critical: persist `runId` to state right after each dispatch. Do NOT hold runIds in memory — on resume or compaction you must be able to recover them from state.

3. After all subtasks are dispatched, transition: `current_phase = "executing"`.

### Phase 4 — EXECUTING (Join: Collect All)

Collect all dispatched results in a single call using the batch tool:

1. Gather all `runId` values from `subtasks` where `status === "dispatched"`.
2. Call `omm_employee_result_batch({ runIds: ["<id1>", "<id2>", ...] })`.
   - This polls all runIds **concurrently** and returns when all resolve (each has its own 60s timeout).
   - Do NOT call `omm_employee_result` individually in a loop — that serializes what should be parallel.
3. For each result in `results`, update the matching subtask:
   - `status: "complete"` → set `subtask.status = "complete"`, store `subtask.result`.
   - `status: "timeout"` → set `subtask.status = "failed"`, note the failure.
4. Write the updated `subtasks` to state.

### Phase 5 — SYNTHESIZING (Multi-Agent Result Merge)

**Only when `agent_count > 1`** and a `critic` persona employee is available. For single-agent or no-critic cases, skip to Phase 6.

1. Transition: `current_phase = "synthesizing"`.
2. Gather all `subtask.result` values into a single context block.
3. Dispatch a synthesis task to the `critic` employee:
   - Message: "Synthesize these subtask results into a unified summary. Identify conflicts and coverage gaps." + the concatenated results.
   - If no employee has a `critic` roleId, skip synthesis (fall through to Phase 6).
4. Poll the result via `omm_employee_result({ runId })`.
5. Write the synthesis to state:
   ```json
   { "synthesis": { "summary": "...", "conflicts": [...], "completedAt": "..." } }
   ```
6. The VERIFYING phase (next) validates against `synthesis.summary`, not raw subtask outputs.

### Phase 6 — VERIFYING / FIXING / COMPLETE

1. Transition: `current_phase = "verifying"`.
2. Verify the synthesis (or single result) against the original task. If issues found and `fix_loop_count < max_fix_loops`:
   - `current_phase = "fixing"`, increment `fix_loop_count`, dispatch a fix subtask to `debugger`/`executor`.
   - Return to EXECUTING for the fix.
3. On success: `current_phase = "complete"`, `active = false`. Report what was accomplished.
4. On failure (max loops exceeded): `current_phase = "failed"`, `active = false`. Report remaining issues.

## Recommended API (omm v0.2 onwards)

Prefer the unified mode-lifecycle helpers from `omm-plugin/src/omm-mode-lifecycle.ts`:

```ts
import { startMode, updateModeState, cancelMode } from "omm-plugin";
await startMode("team", { task, agent_count: 3 });
await updateModeState("team", { current_phase: "delegating" });
await cancelMode("team", "all subtasks verified", { kind: "completed" });
```

## State Schema

```json
{
  "mode": "team",
  "active": true,
  "task": "<original task>",
  "current_phase": "executing",
  "agent_count": 3,
  "fix_loop_count": 0,
  "max_fix_loops": 3,
  "subtasks": [
    {
      "id": "s1",
      "description": "implement auth module",
      "roleId": "executor",
      "assignedTo": "agent-uuid-1",
      "runId": "dispatch-uuid-1",
      "status": "dispatched",
      "result": null
    }
  ],
  "synthesis": null,
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```

### Valid Phases

`planning` → `decomposing` → `delegating` → `executing` → `synthesizing` → `verifying` → (`fixing` loop) → `complete` | `failed`

`synthesizing` is non-terminal (`active` may be `true`).

### Subtask Status Values

`pending` → `dispatched` → `complete` | `failed`

## MA Digital-Employee Bridge

When MatrixAssistant is the host with active digital employees, omm-team dispatches subtasks via `omm_employee_dispatch` and collects via `omm_employee_result_batch`. The MA watcher (host-side) must process dispatch files **concurrently** (`Promise.all` over pending files) for the fork-join pattern to deliver wall-clock speedup. See `docs/plans/omm-ma-employee-bridge.md`.

Autonomous-loop retry/convergence for dispatched subtasks is the host's responsibility (MA `@openclaw/autopilot`, per ADR-008).

## Resume

Read state via `omm_state_read` with `key=team`. If `active=true` and `current_phase` is non-terminal:
- Re-read `subtasks[].runId` from state (do NOT reconstruct from memory).
- If mid-EXECUTING: call `omm_employee_result_batch` with the surviving dispatched runIds.
- If pre-DELEGATING: re-dispatch pending subtasks.

## Completion

When all subtasks are verified, write `current_phase=complete`, `active=false`. Report what was accomplished, citing the `synthesis.summary`.

## Failure

If subtasks fail beyond `max_fix_loops`, write `current_phase=failed`, `active=false`. Report remaining issues and which subtasks are `failed`.
