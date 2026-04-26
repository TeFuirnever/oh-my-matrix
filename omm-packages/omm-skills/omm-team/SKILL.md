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
     "linked_ralph": false,
     "startedAt": "..."
   }
   ```
4. **Delegate** to the upstream team skill. Invoke via `Skill()` with the team skill name and pass `args="<N:agent-type> <task>"`.
5. The upstream team skill handles the full pipeline: `TeamCreate` → task decomposition → `TaskCreate` → worker spawn → monitor → verify/fix loop → `TeamDelete`.
6. **On completion**, write terminal state via `omm_state_write`:
   ```json
   {
     "mode": "team",
     "active": false,
     "current_phase": "complete",
     "task": "<original task>"
   }
   ```

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
  "linked_ralph": false,
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```

### Valid Phases

`planning` → `decomposing` → `executing` → `verifying` → `fixing` → `complete`

The `delegating` phase indicates the upstream team skill is in control.

## Linked Ralph

When invoked as part of omm-ralph, set `linked_ralph=true` in state. On failure, ralph handles retry at the iteration level. omm-team writes `current_phase=failed` and ralph reads team state to decide whether to re-plan.

## Resume

Read state via `omm_state_read` with `key=team`. If `active=true` and `current_phase` is non-terminal, resume by re-delegating to the upstream team skill.

## Completion

When the upstream team skill finishes, write `current_phase=complete`, `active=false`. Report what was accomplished.

## Failure

If the upstream team skill fails or max fix loops exceeded, write `current_phase=failed`, `active=false`. Report remaining issues.
