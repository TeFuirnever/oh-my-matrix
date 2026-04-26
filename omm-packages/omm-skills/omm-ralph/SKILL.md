---
name: omm-ralph
description: Persistent task execution loop with retry and verification
user-invocable: true
disable-model-invocation: false
version: 0.2.0
---

Start or resume an omm-ralph persistent execution loop.

## Usage

```
/omm-ralph <task description>
```

## Lifecycle

Ralph wraps any task in a retry-until-done loop with verification gates.

### State Machine

```
INIT → PLANNING → EXECUTING → VERIFYING → COMPLETE
                      ↑            ↓
                      └── FIXING ←─┘
```

### Phase Descriptions

1. **INIT**: Write initial state via `omm_state_write`. Set `iteration=1`, `status=planning`.
2. **PLANNING**: Analyze the task, identify success criteria, produce an execution plan.
3. **EXECUTING**: Carry out the plan. Write progress to state after each significant step.
4. **VERIFYING**: Check all success criteria are met. Run tests, lint, typecheck as applicable.
5. **FIXING**: If verification fails, diagnose issues and fix them. Increment `fix_attempt`.
6. **COMPLETE**: All criteria met. Write `status=complete` to state.

### Retry Logic

- If FIXING exceeds `max_fix_attempts` (default: 3), increment `iteration` and restart from PLANNING with lessons learned.
- If `iteration` exceeds `max_iterations` (default: 10), write `status=failed` and stop.
- Each iteration appends to `lessons` array in state so subsequent attempts avoid repeating mistakes.

### State Updates

Write state after every phase transition:

```json
{
  "mode": "ralph",
  "active": true,
  "task": "<original task>",
  "iteration": 1,
  "max_iterations": 10,
  "fix_attempt": 0,
  "max_fix_attempts": 3,
  "status": "executing",
  "lessons": [],
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```

### Verification Standards

- Code changes: `tsc --noEmit` passes, linter passes, relevant tests pass.
- File changes: target files exist with expected content.
- Configuration: validate against schema or runtime probe.
- Always verify by running commands, never by assumption.

### Resume

On invocation, first read state via `omm_state_read` with `key=ralph`. If `active=true` and `status` is non-terminal, resume from the current phase rather than starting over.

### Completion

When verified, write `status=complete`, `active=false`. Report what was accomplished and what was verified.

### Failure

When max iterations exhausted, write `status=failed`, `active=false`. Report what was attempted, what failed, and remaining blockers.
