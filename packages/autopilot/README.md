# @oh-my-matrix/autopilot

OpenClaw-native plugin for **continuous, long-running task execution**. Keeps a task
running across turns and enters explainable states on tool errors, stalls, missing
evidence, permission denials, or token-budget exhaustion — instead of silently drifting.

Part of the [oh-my-matrix](https://github.com/TeFuirnever/oh-my-matrix) runtime stack.

## Install

```bash
npm install @oh-my-matrix/autopilot
# peer dependencies
npm install openclaw@">=2026.5.28" @oh-my-matrix/permission-policy
```

## Use

Registers as an OpenClaw plugin (`openclaw.plugin.json`) with hooks including
`before_tool_call`, `after_tool_call`, `before_compaction`, `agent_turn_prepare`,
`before_agent_run`, and `llm_output`. Enable it in your OpenClaw runtime and configure
behaviour via `WORKFLOW.md` (destructive-git policy, retry, evidence gates).

## What it does

- **Continuation engine** — resumes long tasks across turns with a retry queue.
- **Stall / completion detection** — surfaces when a run is stuck or genuinely done.
- **Evidence gate** — blocks completion until success criteria are verified.
- **Projection + goal manager** — preserves run state and goal across compaction.
- **Permission-policy integration** — coordinates the run-scoped policy with
  [`@oh-my-matrix/permission-policy`](../permission-policy).

## Status

v3.0.0. Tested with `vitest` (667+ tests). See the project
[changelog](https://github.com/TeFuirnever/oh-my-matrix/blob/master/CHANGELOG.md).
