---
name: omm-autopilot
description: Autonomous task execution with self-directed planning
user-invocable: true
disable-model-invocation: false
version: 0.2.0
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
    { "step": 1, "description": "...", "status": "completed", "retries": 0 },
    { "step": 2, "description": "...", "status": "executing", "retries": 0 },
    { "step": 3, "description": "...", "status": "pending", "retries": 0 }
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

### Recommended API (omm v0.2 onwards)

Prefer the typed pipeline helpers in `omm-plugin/src/omm-autopilot-pipeline.ts`
over hand-editing the `plan` array. Each helper returns a state patch that
the caller persists via `updateModeState("autopilot", patch)`:

```ts
import { startMode, updateModeState, getModeState, cancelMode } from "omm-plugin";
import {
  validatePlan,
  getCurrentStage,
  markStageStatus,
  advanceStage,
  incrementRetry,
} from "omm-plugin";

await startMode("autopilot", { goal });

// Persist the plan once at PLANNING.
const stages = [...]; // Stage[] = { step, description, status, retries }
if (!validatePlan(stages).ok) throw new Error("invalid plan");
await updateModeState("autopilot", { plan: stages, total_steps: stages.length });

// Per step:
const state = await getModeState("autopilot");
const current = getCurrentStage(state);  // null when past the last stage
// ...do the work...
const done = markStageStatus(state, current.step, "complete", "tests pass");
if (done.ok) await updateModeState("autopilot", done.patch);

// Move to next stage. advanceStage refuses unless current is `complete`.
const adv = advanceStage(await getModeState("autopilot"));
if (adv.ok) await updateModeState("autopilot", adv.patch);
else // step did not finish; loop back into work.

// On failure, bump retry counter (cap policy is up to this skill, not the helper).
const retry = incrementRetry(state, current.step);
if (retry.ok) await updateModeState("autopilot", retry.patch);

await cancelMode("autopilot", "goal achieved", { kind: "completed" });
```

These wrappers enforce immutability (no in-place mutation of the `plan`
array), reject duplicate stage IDs, and refuse to advance past a stage
that is not `complete`.

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
