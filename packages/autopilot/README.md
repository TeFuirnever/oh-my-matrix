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

## What it does

- **Continuation engine** — resumes long tasks across turns with exponential-backoff retry.
- **Stall / completion detection** — surfaces when a run is stuck or genuinely done.
- **Evidence gate** — blocks completion until validation commands pass (opt-in via `trustWorkspace`).
- **Orchestrator reducer** — pure-function state machine (7 states, immutable transitions).
- **Projection + goal manager** — preserves run state and goal across compaction.
- **Model routing** — cost-aware tier selection per execution phase (budget/standard/premium).
- **Permission-policy integration** — coordinates the run-scoped policy with
  [`@oh-my-matrix/permission-policy`](../permission-policy).

## Plugin config

Set via `openclaw.plugin.json` or host `pluginConfig`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxAttemptsPerTurn` | number | `5` | Max revise attempts within a single turn |
| `maxTotalContinuations` | number | `50` | Max total continuations across all turns |
| `toolErrorThreshold` | number | `3` | Consecutive identical tool errors before pause |
| `excludedAgents` | string[] | `[]` | Agent IDs to skip (no autopilot hooks) |
| `highRiskTools` | string[] | — | Additional tools to block for subagents |
| `tokenBudget` | number | — | Total token budget; pauses when exceeded |
| `maxConcurrentAutopilot` | number | `5` | Max simultaneous autopilot runs |
| `thinkingIntensity` | `'low'\|'medium'\|'high'` | `'high'` | Graduated thinking effort injection |
| `trustWorkspace` | boolean | `false` | Enable workspace-sourced validation commands |
| `modelRouting` | object | — | Tier→model mapping (see Model routing below) |

## Gateway methods

| Method | Params | Description |
|--------|--------|-------------|
| `autopilot.activate` | `{ sessionKey, goal?, maxTotalContinuations?, tokenBudget?, trustWorkspace? }` | Start or re-activate a run. Returns `{ ok, runId, projection }` |
| `autopilot.stop` | `{ sessionKey }` | Stop a running session (sets `blockedReason: 'user_stopped'`) |
| `autopilot.resume` | `{ sessionKey }` | Resume from `paused` status (resumable blocked reasons only) |
| `autopilot.status` | `{ sessionKey }` | Query current projection for a session |
| `autopilot.setGoal` | `{ sessionKey, goal }` | Update the run goal mid-flight |
| `autopilot.cleanup` | — | Clear all internal state (all runs, maps, intervals) |

## WORKFLOW.md format

Place a `WORKFLOW.md` with YAML front matter in the workspace root to configure per-workspace behavior:

```yaml
---
autopilot:
  version: 1
  permission_mode: guarded_yolo
  max_concurrent: 3
  max_retries: 5
  stall_timeout_ms: 60000
  max_retry_backoff_ms: 120000
  workspace:
    root: .matrix/worktrees
    cleanup: delete_on_done
    branch_prefix: auto
  validation:
    commands:
      - id: test
        command: pnpm test
        timeout_ms: 30000
        required: true
  destructive_git:
    allow: false
  model_routing:
    default_tier: standard
    initial_turn_tier: premium
    validation_tier: budget
    model_ids:
      budget: claude-haiku-4-5-20251001
      standard: claude-sonnet-4-6
      premium: claude-opus-4-6
---
```

Validation command binaries are allowlisted (npm, pnpm, node, vitest, tsc, go, cargo, python, etc.); disallowed binaries (curl, wget, bash, sh) are dropped with a warning.

## AutopilotProjection fields

The `autopilot.status` gateway returns a projection object:

| Field | Type | Description |
|-------|------|-------------|
| `status` | `'idle'\|'running'\|'paused'\|'done'` | Current run status |
| `orchestrationState` | `'unclaimed'\|'claimed'\|'running'\|'retry_queued'\|'released'\|'blocked'\|'done'` | Orchestrator state |
| `enabled` | boolean | Whether autopilot is active |
| `turnAttempts` / `totalContinuations` | number | Current turn / total counters |
| `pauseReason` | string? | Why the run paused |
| `blockedReason` | string? | Why the run is blocked |
| `canStop` | boolean | Whether stop is meaningful |
| `lastGoal` | string? | Truncated goal text |
| `totalTokensUsed` / `inputTokensUsed` / `outputTokensUsed` | number | Token accounting |
| `estimatedCostUsd` | number | Estimated API cost (Claude Sonnet pricing) |
| `evidenceStatus` | string? | Evidence gate status |
| `workspacePath` / `workspaceBranch` | string? | Workspace info |
| `thinkingIntensity` / `modelTier` / `recommendedModelId` | string? | Current routing |

## Environment variables

No environment variables are required. The plugin reads all configuration from `pluginConfig` and `WORKFLOW.md`.

## Troubleshooting

**Run stuck at `claimed`?** — The host must emit `agent_turn_prepare` before `before_agent_finalize` for the orchestrator to advance through `running` → `released` → `done`.

**Evidence gate always skipped?** — Set `trustWorkspace: true` in the activate payload or plugin config. Without it, workspace-sourced validation commands are not executed (security: untrusted workspaces cannot reach RCE).

**"audit plugin not loaded" warning?** — Normal if `@openclaw/matrixassistant-audit` is not installed. Autopilot works without it (degraded but safe).

**Token budget not enforcing?** — Budget enforcement happens at the `before_agent_finalize` turn boundary (`continuation-engine.ts`). Subagent tokens are counted toward the parent run's budget.

## Known limitations

Tracked in [issue #53](https://github.com/TeFuirnever/oh-my-matrix/issues/53):

- **S2 — allow-by-default on the autonomous loop.** Unclassified tools auto-run in the main autopilot session. This is by design: a fail-closed autonomous loop would stall on every unfamiliar tool. The fail-closed surface is the **subagent guard** (`@oh-my-matrix/dynamic-workflows`), which blocks destructive ops for `:subagent:` sessions regardless of classification.
- **S4 — `process.cwd()` workspace fallback.** When no `workspacePath` is supplied in the activate payload, autopilot falls back to `process.cwd()`. `validateWorkspacePath` rejects untrusted paths, but the fallback itself remains. Always pass `workspacePath` explicitly in production.
- **S5 — Windows `shell: true`.** On Windows, `command-runner.ts` conditionally enables `shell: true` for cmd-like commands and non-ASCII arguments (mirrors the gateway). This re-enables shell metacharacters that the classifier strips. Mitigated by the binary allowlist + `trustWorkspace` boundary, but Windows deployments should audit command construction.

## Migration from 2.x

The **only breaking change** in 3.0.0 is the `trustWorkspace` default flip:

| behavior | 2.x (default) | 3.0.0 (default) |
|---|---|---|
| Workspace-sourced validation commands (`npm run`, `node script.js`, `python -c`) | executed automatically | **not executed** unless `trustWorkspace: true` |

To restore 2.x behavior, set `trustWorkspace: true` in the activate payload or plugin config. See [PR #45](https://github.com/TeFuirnever/oh-my-matrix/pull/45) for the full security rationale (closes the WORKFLOW.md to RCE vector, S1).

All other 3.0.0 changes (model routing, thinking intensity, new BlockedReason values, stall detection for `claimed` runs) are additive and backward-compatible.

## Status

v3.0.0. Tested with `vitest` (787 tests, 91%+ statement coverage). See the project
[changelog](https://github.com/TeFuirnever/oh-my-matrix/blob/master/CHANGELOG.md).
