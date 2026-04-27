# Getting Started

## Install the omm Bundle

omm is distributed as a single tarball. Unpack it into your host's resources directory:

```bash
tar -xzf omm-suite-0.3.0-alpha.2.tgz -C resources/
```

The bundle contains:

- `omm-plugin/` — OpenClaw plugin (tools + lifecycle hooks)
- `omm-mcp/` — State MCP server (stdio JSON-RPC)
- `omm-mcp-memory/` — Memory MCP server
- `omm-mcp-trace/` — Trace MCP server
- `omm-skills/` — SKILL.md workflow definitions

## Register MCP Servers

Add the three MCP servers to your OpenClaw `mcpServers` config:

```json
{
  "mcpServers": {
    "omm-state": {
      "command": "node",
      "args": ["resources/omm-mcp/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "~/.openclaw/omm" }
    },
    "omm-memory": {
      "command": "node",
      "args": ["resources/omm-mcp-memory/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "~/.openclaw/omm" }
    },
    "omm-trace": {
      "command": "node",
      "args": ["resources/omm-mcp-trace/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "~/.openclaw/omm" }
    }
  }
}
```

## Three Workflow Modes

### ralph — Iterative Execution Loop

ralph runs a persistent plan→execute→verify→fix cycle with retry tracking. Use it for open-ended tasks that may need multiple attempts.

Invoke via the `omm-ralph` skill or directly trigger the state machine:

```
Status: init → planning → executing → verifying ↔ fixing → complete | failed
```

### autopilot — Autonomous Multi-Step Pipeline

autopilot decomposes a goal into numbered steps and executes them sequentially with per-step verification.

```
Status: analyzing → planning → executing → verifying ↔ retry → complete | blocked | failed
```

### team — Parallel Agent Delegation

team delegates subtasks to parallel worker agents via the host's `TeamCreate`/`TaskCreate` primitives.

```
Phase: planning → decomposing → delegating → executing → verifying ↔ fixing → complete | failed
```

Only one mode may be `active: true` at a time. Attempting to activate a second mode while one is running returns `OMM_E_WORKFLOW_CONFLICT`.

## First omm_state_write Call

Write an initial ralph state to begin a workflow:

```json
{
  "tool": "omm_state_write",
  "arguments": {
    "key": "ralph",
    "value": {
      "mode": "ralph",
      "active": true,
      "status": "init",
      "task": "Refactor the auth module to use structured error codes"
    }
  }
}
```

Expected response:

```
Written: /home/user/.openclaw/omm/state/ralph.json
```

omm injects defaults automatically: `iteration=0`, `max_iterations=10`, `fix_attempt=0`, `max_fix_attempts=3`, `startedAt=<now>`.

Read the state back at any time:

```json
{
  "tool": "omm_state_read",
  "arguments": { "key": "ralph" }
}
```

Cancel an active workflow:

```json
{
  "tool": "omm_cancel",
  "arguments": { "key": "ralph" }
}
```

## Next Steps

- [Architecture Overview](/guide/architecture) — module decomposition and data flow
- [Reference: Tool Index](/reference/) — all plugin and MCP tools
- [Reference: Error Codes](/reference/contracts/error-codes) — stable `OMM_E_*` identifiers
- [ADR-004: Three-Mode State Machine](/reference/adrs/004) — design rationale
