# Tool Reference

Complete index of all tools provided by omm — plugin tools (in-process via OpenClaw) and MCP server tools (out-of-process via stdio JSON-RPC).

## Plugin Tools (omm-plugin)

These five tools are registered via `api.registerTool()` and dispatched by the OpenClaw Gateway.

| Tool              | Summary                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `omm_state_write` | Atomically write a JSON object to a named state key; applies mode-aware validation for ralph/autopilot/team |
| `omm_state_read`  | Read the current JSON state for a named key; returns the full object including injected timestamps          |
| `omm_state_list`  | List all state keys present in the state directory                                                          |
| `omm_ping`        | Health-check tool; returns `{ ok: true }` — use to verify the plugin is loaded and responsive               |
| `omm_cancel`      | Cancel an active workflow by setting `active=false` on the named key's state                                |

All plugin tools are registered with `{ optional: true }` — the host functions normally if omm is not loaded.

See [State Contract](/reference/contracts/state-contract) and [Error Codes](/reference/contracts/error-codes) for input/output details.

## omm-memory Tools

The `omm-mcp-memory` server exposes four tools for persistent cross-session key-value memory.

| Tool                | Summary                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `omm_memory_set`    | Write a value to a named memory key; persists across sessions in `{stateRoot}/memory/`  |
| `omm_memory_get`    | Read the current value for a named memory key; returns `null` if the key does not exist |
| `omm_memory_list`   | List all memory keys currently stored                                                   |
| `omm_memory_delete` | Delete a named memory key and its persisted file                                        |

## omm-trace Tools

The `omm-mcp-trace` server exposes four tools for execution trace recording and metrics.

| Tool                | Summary                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `omm_trace_record`  | Append a structured event to the session trace log; optionally include `durationMs`, `toolName`, `ok` for metric aggregation |
| `omm_trace_list`    | List trace events for a session, optionally filtered by time range or event type                                             |
| `omm_trace_query`   | Query trace events with structured filters (session, type, since/until timestamps)                                           |
| `omm_trace_metrics` | Aggregate P50/P99 latency and error rate from metric-carrying trace records; supports `sessionId` and `sinceMs` filters      |

See [Observability Contract](/reference/contracts/observability) for the `omm_trace_metrics` output schema and aggregation algorithm.
