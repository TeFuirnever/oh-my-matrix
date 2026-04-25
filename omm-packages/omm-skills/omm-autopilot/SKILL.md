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

Autopilot manages self-directed planning and execution state in `~/.openclaw/omm/state/autopilot.json`.

## Usage

```
/omm-autopilot <goal description>
```

## Behavior

1. Writes initial autopilot state via `omm_state_write`
2. Analyzes goal and generates execution plan
3. Executes steps autonomously with progress tracking
4. Self-corrects on failure, escalates when blocked

## State Schema

```json
{
  "active": true,
  "goal": "...",
  "current_step": 1,
  "total_steps": 0,
  "status": "planning",
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```
