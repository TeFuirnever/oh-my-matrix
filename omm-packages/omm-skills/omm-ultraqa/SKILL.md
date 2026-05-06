---
name: omm-ultraqa
description: Autonomous QA cycling - test, verify, fix, repeat until goal met
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start an autonomous QA cycling session.

## Usage

```
/omm-ultraqa <goal: tests|build|lint|typecheck|custom description>
```

## Purpose

UltraQA runs an autonomous test-fix loop until a quality goal is met. It cycles through verification, diagnosis, and fix phases up to 5 times, stopping early if the same error repeats 3 times (indicating a fundamental issue).

## Goal Types

| Input | What to Check | Command |
|-------|---------------|---------|
| `tests` | All test suites pass | Project's test command |
| `build` | Build succeeds with exit 0 | Project's build command |
| `lint` | No lint errors | Project's lint command |
| `typecheck` | No TypeScript errors | `tsc --noEmit` |
| Custom text | Custom success pattern | Appropriate command |

If no structured goal is provided, interpret the argument as a custom goal description.

## Lifecycle

### Initialize

Write state via `omm_state_write` with key `ultraqa`:

```json
{
  "mode": "ultraqa",
  "active": true,
  "goal": "<goal type and description>",
  "cycle": 0,
  "max_cycles": 5,
  "last_error": null,
  "repeat_count": 0,
  "history": [],
  "status": "running",
  "startedAt": "<ISO8601>"
}
```

### Cycle Workflow (Max 5)

#### Step 1: Run QA

Execute verification based on goal type. Record the result.

#### Step 2: Check Result

- **PASS** → Exit with success
- **FAIL** → Continue to Step 3

#### Step 3: Diagnose

Load architect role prompt via `omm_agent_prompt_get({ name: "architect" })`.

Analyze the failure output:
- Identify root cause
- Classify: compilation error, test assertion, runtime error, dependency issue, environment issue
- Recommend specific fix actions

#### Step 4: Fix

Apply the architect's recommended fix. Be surgical — change only what's needed.

#### Step 5: Record

Append to history:

```json
{
  "cycle": 1,
  "result": "fail",
  "error_summary": "<first line of error>",
  "diagnosis": "<root cause>",
  "fix_applied": "<what was changed>",
  "timestamp": "<ISO8601>"
}
```

Update state: increment `cycle`, update `last_error`.

#### Step 6: Check for Stuck

Compare `last_error` with previous cycle's error:
- If same error repeats: increment `repeat_count`
- If `repeat_count >= 3`: **STOP** — fundamental issue detected

### Exit Conditions

| Condition | Action |
|-----------|--------|
| Goal met | "ULTRAQA COMPLETE: Goal met after N cycles" |
| Max cycles reached | "ULTRAQA STOPPED: Max cycles. Last diagnosis: ..." |
| Same failure 3x | "ULTRAQA STOPPED: Same failure 3 times. Root cause: ..." |

On exit, update state: `active: false`, `status: "complete"|"failed"|"stuck"`.

### Resume

Read state via `omm_state_read` with key `ultraqa`. If `active=true`, resume from the current cycle.

> **Important:** When `omm_state_read` returns `null`, initialize via `omm_state_write`.

### Trace Integration

UltraQA records each cycle as a trace event via `omm_trace_record`:

```json
{
  "timestamp": "<ISO8601>",
  "type": "ultraqa_cycle",
  "cycle": 1,
  "goal": "<goal>",
  "result": "fail",
  "toolName": "<tool that failed>",
  "error": "<error summary>"
}
```

This enables hosts to surface QA progress in the workflow graph.
