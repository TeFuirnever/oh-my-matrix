# omm Degradation Contract

**Status:** Stable from v0.3.0
**Audience:** Host integrators (MatrixAssistant Electron, OpenClaw runtime, third-party plugin consumers)

## Overview

omm is composed of independent subsystems: the in-process plugin (state, skill execution), the omm-memory MCP server, and the omm-trace MCP server. Each subsystem may fail in isolation. This document specifies the observable behavior under each failure mode and the recovery procedures for each case.

---

## 1. omm-memory MCP Fails

**Does ralph still work?** Yes.

omm-memory is an optional observability aid. It provides the `omm_memory_set`, `omm_memory_get`, `omm_memory_delete`, and `omm_memory_list` tools via MCP. When the server is unavailable:

- The four memory tools become unavailable to the host runtime.
- ralph SKILL.md instructions that recommend memory operations (e.g. "store context for next turn") continue to execute but return an MCP-unavailable error from the host.
- Skill loop retry logic treats memory errors as non-fatal: the loop logs the failure, skips the memory step, and continues execution.
- No workflow state is affected; `omm_state_write` and `omm_state_read` are unrelated to the memory MCP.

**Behavior table:**

| Tool | Availability | Error returned |
|---|---|---|
| `omm_memory_set` | Unavailable | MCP transport error (host-level) |
| `omm_memory_get` | Unavailable | MCP transport error (host-level) |
| `omm_memory_delete` | Unavailable | MCP transport error (host-level) |
| `omm_memory_list` | Unavailable | MCP transport error (host-level) |
| `omm_state_write` | Unaffected | — |
| ralph skill execution | Unaffected | — |

---

## 2. omm-trace MCP Fails

**Does autopilot still complete?** Yes.

omm-trace is observability-only. It provides `omm_trace_record` and `omm_trace_metrics`. When the server is unavailable:

- `omm_trace_record` calls are logged by the host and silently dropped. No error propagates to the calling skill or workflow.
- `omm_trace_metrics` returns an empty `MetricsResult`:

```ts
{
  count: 0,
  p50: 0,
  p90: 0,
  p99: 0,
  errorRate: 0
}
```

- autopilot, ralph, and team SKILL.md execution paths are unaffected. Tracing is not on the execution critical path.
- Hosts may choose to surface a warning indicator in their UI but must not block workflow execution.

---

## 3. omm-state MCP Fails — omm-plugin State Tools Still Work

**Hybrid partial-failure mode. This is the safest partial-failure scenario.**

The omm-plugin's `omm_state_write` and `omm_state_read` tools run in-process inside the OpenClaw plugin host. The omm-state MCP server exposes the same state directory to out-of-process clients (e.g. external tooling, dashboard observers).

When the MCP server is unavailable but the plugin is loaded:

- In-process callers (ralph, autopilot, team SKILL.md via plugin tools) continue normally. All state writes succeed.
- Out-of-process MCP clients (external tools, omm CLI, dashboard) lose access to the state directory.
- Workflow state transitions remain consistent because all active workflows use the plugin path.
- No recovery action is required for in-flight workflows.

**Behavior table:**

| Access path | Status | Effect |
|---|---|---|
| Plugin `omm_state_write` | Functional | Writes succeed |
| Plugin `omm_state_read` | Functional | Reads succeed |
| MCP `omm_state_write` | Unavailable | JSON-RPC transport error |
| MCP `omm_state_read` | Unavailable | JSON-RPC transport error |
| ralph / autopilot / team | Unaffected | Continue normally |

Host integrators should treat this mode as a degraded-but-stable state: log the MCP server absence, suppress external dashboard features, and allow workflows to proceed.

---

## 4. omm-plugin State Subsystem Fails (Filesystem / OOM)

**Critical path broken.**

When the plugin's own state subsystem fails — due to a full disk, permission denial, `ENOSPC`, or an out-of-memory condition — `omm_state_write` returns `OMM_E_IO_FAILED`.

**For new workflow starts:**

- The host must refuse to start new ralph, autopilot, or team workflows.
- Surface the failure to the user via `formatOmmError()` with retry guidance.
- Example user-facing message: `"Workflow storage unavailable (OMM_E_IO_FAILED). Free disk space and retry, or contact support."`

**For already-running workflows:**

- Their in-memory state diverges from persisted state immediately after the first failed write.
- The workflow may continue executing, but its state is stale and cannot be recovered automatically.
- Recovery requires the user to run `state_clear` for each affected session:

```
omm_plugin: state_clear({ sessionId: "<affected-session-id>" })
```

- After clearing stale state, the user may restart the workflow from the beginning.

**Host integrator required actions:**

1. Catch `OMM_E_IO_FAILED` on any `omm_state_write` call.
2. Call `formatOmmError(result.details.structured)` and surface the message in the UI.
3. Set an internal flag to block new workflow launch until the condition clears.
4. Instruct the user to check disk space and filesystem permissions before retrying.

---

## 5. Cross-Process Lock Contention Exhausts Retry Budget

**Error code:** `OMM_E_LOCK_TIMEOUT` (after 5 s).

omm uses cross-process file-based locks for state writes that require exclusivity (see ADR-005). When a lock cannot be acquired within the 5-second budget:

- `omm_state_write` returns `OMM_E_LOCK_TIMEOUT`.
- The calling SKILL.md is expected to apply backoff-and-retry logic before surfacing to the user.

**Recommended retry sequence in SKILL.md:**

```
1. Receive OMM_E_LOCK_TIMEOUT
2. Wait 2s (first retry)
3. Retry omm_state_write
4. If still OMM_E_LOCK_TIMEOUT, wait 5s (second retry)
5. Retry omm_state_write
6. If still failing, surface OMM_E_LOCK_TIMEOUT to host
```

**Stale-lock recovery window (ADR-005):**

A lock file is considered stale if it has not been updated within 30 seconds. The omm state subsystem automatically reclaims stale locks on the next write attempt. No manual intervention is required unless the holding process is confirmed hung. If a lock remains after 30 s, the next `omm_state_write` will claim it and proceed.

If lock contention persists beyond two retries, the host should scan for orphaned writer processes:

```bash
# Check for hung omm-related processes
ps aux | grep omm
```

---

## 6. Recovery Procedures

### Verify MCP server liveness

```bash
# Check mcporter status for all omm servers
mcporter status omm-memory
mcporter status omm-trace
mcporter status omm-state
```

A healthy server reports `running` status. An unhealthy server reports `stopped`, `crashed`, or `unresponsive`.

### Restart a failed MCP server

```bash
mcporter restart omm-memory
mcporter restart omm-trace
mcporter restart omm-state
```

After restart, MCP tools become available again without reloading the host plugin.

### When manual state cleanup is required

Manual `state_clear` is required only in failure mode 4 (plugin state subsystem failure) for already-running workflows. It is not required for MCP-level failures (modes 1–3) because in-process state remains intact.

```
# Per affected session
omm_plugin: state_clear({ sessionId: "<session-id>" })

# List active sessions to find affected IDs
omm_plugin: state_list_active({})
```

After clearing, verify the state directory is writable before restarting workflows:

```bash
ls -la ~/.openclaw/omm/state/
touch ~/.openclaw/omm/state/.write-test && rm ~/.openclaw/omm/state/.write-test
```

### Lock contention recovery

If `OMM_E_LOCK_TIMEOUT` persists after the 30 s stale-lock window, remove the lock file manually:

```bash
rm ~/.openclaw/omm/state/*.lock
```

Only do this after confirming no active writer process holds the lock.

---

## 7. Host Integrator Checklist

Implement the following in any host that embeds the omm plugin:

### MCP health polling

- Poll `mcporter status` for `omm-memory`, `omm-trace`, and `omm-state` every **30 seconds**.
- On status change from `running` to non-running, log the transition and update internal availability flags.
- Do not block workflow execution for `omm-memory` or `omm-trace` failures.
- For `omm-state` MCP failure: allow in-process plugin workflows to continue; disable external state viewers.

### Branch on missing servers

```ts
const memoryAvailable = await mcporter.status("omm-memory") === "running";
const traceAvailable  = await mcporter.status("omm-trace")  === "running";
const stateMcpAvailable = await mcporter.status("omm-state") === "running";

// Only block new workflows on plugin-level IO failure, not MCP failure
if (lastStateWriteError?.code === "OMM_E_IO_FAILED") {
  blockNewWorkflows();
}
```

### Surface errors to UI

Use `formatOmmError()` for all structured errors before displaying to users:

```ts
import { formatOmmError } from "@omm/plugin";

const result = await ommTool.execute(callId, params, signal, onUpdate);
if (result.details?.structured) {
  const msg = formatOmmError(result.details.structured);
  ui.showError(msg);
}
```

`formatOmmError()` produces a user-readable string with remediation guidance. Never display raw `OMM_E_*` codes directly to end users.

### Retry guidance by error code

| Error code | Host action |
|---|---|
| `OMM_E_IO_FAILED` | Block new workflows; surface disk/permission guidance; require user acknowledgement before retry |
| `OMM_E_LOCK_TIMEOUT` | Retry twice with 2 s / 5 s backoff; if still failing, surface to user with "another process may be stuck" guidance |
| `OMM_E_INTERNAL` | Log full context; surface generic error; do not retry automatically |
| MCP transport error (memory/trace) | Log; skip the step; do not surface to user unless persistent |
| MCP transport error (state) | Log; check plugin path still functional; disable external clients only |
