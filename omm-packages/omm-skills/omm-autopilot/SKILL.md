---
name: omm-autopilot
description: Autonomous task execution with self-directed planning
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: omm_state_write
command-arg-mode: raw
version: 0.1.0
---

Start or resume an omm-autopilot autonomous execution session.

## Usage

```
/omm-autopilot <goal description>
```

## Lifecycle

Autopilot takes a high-level goal and autonomously plans, executes, and verifies without further user input.

### State Machine

```
ANALYZING → PLANNING → STEP_N → VERIFYING → COMPLETE
                          ↑          ↓
                          └── RETRY ─┘
```

### Phase Descriptions

1. **ANALYZING**: Explore the codebase to understand current state relevant to the goal. Identify constraints, patterns, and dependencies.
2. **PLANNING**: Generate a numbered step list with clear success criteria per step. Write plan to state.
3. **STEP_N**: Execute step N. After each step, write progress to state and verify the step succeeded before advancing.
4. **VERIFYING**: After all steps complete, run end-to-end verification against the original goal.
5. **RETRY**: If a step or final verification fails, diagnose and retry that step (max 3 retries per step).
6. **COMPLETE**: Goal achieved. Write `status=complete`.

### State Schema

```json
{
  "mode": "autopilot",
  "active": true,
  "goal": "<original goal>",
  "current_step": 2,
  "total_steps": 5,
  "status": "executing",
  "plan": [
    {"step": 1, "description": "...", "status": "completed", "retries": 0},
    {"step": 2, "description": "...", "status": "executing", "retries": 0},
    {"step": 3, "description": "...", "status": "pending", "retries": 0}
  ],
  "max_retries_per_step": 3,
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```

### Execution Rules

- Execute one step at a time, sequentially.
- Verify each step before advancing to the next.
- If a step fails, retry up to `max_retries_per_step` times with a different approach.
- If retries exhausted for any step, write `status=blocked` with the failure details and stop.
- Never skip a step or proceed past a failed verification.

### Self-Correction

- On step failure, read the error output and adjust the approach.
- Record what was tried and why it failed in the step's state.
- Subsequent retries must use a different strategy than previous attempts.

### Progress Communication

- After each step completion, write updated state.
- State is the single source of truth for progress.
- On resume, read state and continue from `current_step`.

### Resume

Read state via `omm_state_read` with `key=autopilot`. If `active=true` and `status` is non-terminal, resume from `current_step`.

### Completion

When final verification passes, write `status=complete`, `active=false`. Summarize all steps taken and their outcomes.

### Blocked

When a step exhausts retries, write `status=blocked`, `active=false`. Report the blocking step, attempts made, and suggested next actions for the user.
