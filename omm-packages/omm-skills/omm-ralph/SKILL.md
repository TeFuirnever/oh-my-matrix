---
name: omm-ralph
description: Persistent task execution loop with retry and verification
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: omm_state_write
command-arg-mode: raw
version: 0.1.0
---

Start or resume an omm-ralph persistent execution loop.

Ralph tracks iteration state in `~/.openclaw/omm/state/ralph.json` and retries failed tasks until completion or max iterations.

## Usage

```
/omm-ralph <task description>
```

## Behavior

1. Writes initial ralph state via `omm_state_write`
2. Agent reads state, executes task, writes progress
3. On failure: increments iteration, retries
4. On success: marks complete in state

## State Schema

```json
{
  "active": true,
  "task": "...",
  "iteration": 1,
  "maxIterations": 10,
  "status": "running",
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```
