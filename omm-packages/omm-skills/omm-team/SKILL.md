---
name: omm-team
description: Multi-agent team orchestration with external team skill bridge
user-invocable: true
disable-model-invocation: false
version: 0.2.0
---

Start or resume an omm-team multi-agent execution pipeline.

## Usage

```
/omm-team <task description>
/omm-team N:agent-type <task description>
```

## Architecture

omm-team provides **state tracking and integration coordination** while delegating actual parallel execution to the host environment's team skill. This avoids reimplementing worker spawning — the native `Task` tool with `TeamCreate`/`TaskCreate`/`SendMessage` handles parallelism.

## Lifecycle

1. **Receive** user task description and optional `N:agent-type` parameter.
2. **Read state** via `omm_state_read` with `key=team`. If `active=true` and `current_phase` is non-terminal, resume from that phase.

   > **Important — interpreting `omm_state_read` responses**: when no state file exists yet (first run, or after `cancel`), the tool returns the literal text `null`. **This is normal — it means "not started yet", not an error.** Do not retry, do not assume the tool is broken. Proceed by initializing state via `omm_state_write` with `key=team` and `active=true` (or call `startMode("team", ...)`).

3. **Write initial state** via `omm_state_write`:
   ```json
   {
     "mode": "team",
     "active": true,
     "task": "<original task>",
     "current_phase": "delegating",
     "agent_count": 3,
     "fix_loop_count": 0,
     "max_fix_loops": 3,
     "startedAt": "..."
   }
   ```
4. **Detect MA digital employees** (MA-employee priority with host fallback). Call `omm_employee_list`:
   - **Employees available**: decompose the task into subtasks, then for each subtask call `omm_employee_dispatch({ agentId, message })` → poll `omm_employee_result({ runId })` until `status: "complete"` or timeout. Aggregate outputs for the verify step.
   - **No employees** (empty list — host is not MatrixAssistant, or no employee activated): fall back to host-native execution — `Skill()` the team skill with `args="<N:agent-type> <task>"`.

   > MA digital employees (OpenClaw Agents) are the preferred execution backend when available; the host team skill is the universal fallback. See `docs/plans/omm-ma-employee-bridge.md`.
5. The host team skill (fallback path) handles the full pipeline: `TeamCreate` → task decomposition → `TaskCreate` → worker spawn → monitor → verify/fix loop → `TeamDelete`.
6. **On completion**, write terminal state via `omm_state_write`:
   ```json
   {
     "mode": "team",
     "active": false,
     "current_phase": "complete",
     "task": "<original task>"
   }
   ```

## Recommended API (omm v0.2 onwards)

Prefer the unified mode-lifecycle helpers from `omm-plugin/src/omm-mode-lifecycle.ts`
over hand-assembling state objects. The team mode uses `current_phase` (not
`status`) — the helpers handle this automatically.

```ts
import { startMode, updateModeState, cancelMode } from "omm-plugin";

// init
await startMode("team", { task, agent_count: 3 });

// during run, e.g. after delegating
await updateModeState("team", { current_phase: "delegating" });

// when the upstream team skill returns success
await cancelMode("team", "all subtasks verified", { kind: "completed" });
```

When running under MatrixAssistant with active digital employees, the
MA-employee dispatch path (lifecycle step 4) takes priority over
host-native team execution.

## State Schema

```json
{
  "mode": "team",
  "active": true,
  "task": "<original task>",
  "current_phase": "delegating",
  "subtasks": [],
  "agent_count": 3,
  "fix_loop_count": 0,
  "max_fix_loops": 3,
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```

### Valid Phases

`planning` → `decomposing` → `executing` → `verifying` → `fixing` → `complete`

The `delegating` phase indicates the upstream team skill is in control.

## MA Digital-Employee Bridge

When MatrixAssistant is the host with active digital employees, omm-team dispatches subtasks to them via `omm_employee_dispatch` / `omm_employee_result` (lifecycle step 4) instead of the host team skill. Autonomous-loop retry/convergence for those subtasks is the host's responsibility (MA `@openclaw/autopilot`, per [ADR-008](docs/adr/008-delegation-to-host.md)). If no employees are available, omm-team falls back to host-native `Skill("team")`.

## Resume

Read state via `omm_state_read` with `key=team`. If `active=true` and `current_phase` is non-terminal, resume by re-delegating to the upstream team skill.

## Completion

When the upstream team skill finishes, write `current_phase=complete`, `active=false`. Report what was accomplished.

## Failure

If the upstream team skill fails or max fix loops exceeded, write `current_phase=failed`, `active=false`. Report remaining issues.
