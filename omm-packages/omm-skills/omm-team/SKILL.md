---
name: omm-team
description: Multi-agent team orchestration with staged pipeline
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: omm_state_write
command-arg-mode: raw
version: 0.1.0
---

Start or resume an omm-team multi-agent execution pipeline.

Team tracks orchestration state in `~/.openclaw/omm/state/team.json` and coordinates workers through a staged pipeline.

## Usage

```
/omm-team <task description>
```

## Behavior

1. Writes initial team state via `omm_state_write`
2. Decomposes task into subtasks with dependencies
3. Assigns workers and monitors progress
4. Runs verify/fix loop until completion or max iterations

## State Schema

```json
{
  "active": true,
  "task": "...",
  "current_phase": "team-plan",
  "agent_count": 3,
  "fix_loop_count": 0,
  "max_fix_loops": 3,
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```
