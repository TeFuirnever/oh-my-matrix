---
name: omm-team
description: Multi-agent team orchestration with staged pipeline
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: omm_state_write
command-arg-mode: raw
version: 0.2.0
---

Start or resume an omm-team multi-agent execution pipeline.

## Usage

```
/omm-team <task description>
```

## Lifecycle

Team decomposes a task into subtasks, assigns them to parallel workers, and runs a verify/fix loop.

### Pipeline Stages

```
PLANNING → DECOMPOSING → EXECUTING → VERIFYING → COMPLETE
                             ↑            ↓
                             └── FIXING ←─┘
```

### Stage Descriptions

1. **PLANNING**: Analyze the codebase and task scope. Identify files, modules, and dependencies involved.
2. **DECOMPOSING**: Break the task into independent, file-scoped subtasks. Each subtask should be completable without conflicts. Write the task list to state.
3. **EXECUTING**: Assign subtasks to workers. Workers execute in parallel on non-overlapping file sets. Track per-worker progress in state.
4. **VERIFYING**: After all workers complete, verify the combined result. Run typecheck, tests, and acceptance checks.
5. **FIXING**: If verification fails, create fix tasks targeting specific failures. Route to workers and re-verify.
6. **COMPLETE**: All checks pass. Write `status=complete`.

### State Schema

```json
{
  "mode": "team",
  "active": true,
  "task": "<original task>",
  "current_phase": "executing",
  "subtasks": [
    {
      "id": 1,
      "description": "...",
      "owner": "worker-1",
      "status": "completed"
    },
    {
      "id": 2,
      "description": "...",
      "owner": "worker-2",
      "status": "in_progress"
    }
  ],
  "agent_count": 3,
  "fix_loop_count": 0,
  "max_fix_loops": 3,
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```

### Decomposition Rules

- Each subtask targets a specific file or module to avoid merge conflicts.
- Shared types or interfaces should be a separate task completed first (dependency).
- Subtask descriptions must be self-contained: include file paths, expected behavior, and verification command.
- Maximum subtask count equals worker count; consolidate if tasks are too granular.

### Worker Coordination

- Workers must not edit the same files.
- If a worker is blocked, it reports the blocker and stands by.
- The lead monitors progress and reassigns failed tasks.
- Workers report completion with a summary of changes made.

### Fix Loop

- Maximum `max_fix_loops` (default: 3) iterations of verify → fix → re-verify.
- Each fix iteration targets specific verification failures, not the entire task.
- If max fix loops exceeded, write `status=failed` with remaining issues.

### Resume

Read state via `omm_state_read` with `key=team`. If `active=true`, resume from `current_phase`.

### Linked Ralph

When invoked as part of omm-ralph, team writes `linked_ralph=true` in state. On failure, ralph handles retry at the iteration level.
