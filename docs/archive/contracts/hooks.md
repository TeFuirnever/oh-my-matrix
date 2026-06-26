# omm Hook System

> 🗄 **归档 / Archived** — v0.x OpenClaw 插件/MCP 实现的设计记录。代码已于 0.6.0 移除；本仓库现为文档/设计底座。内部链接可能已失效。

**Status:** Stable from v0.3.0
**Audience:** Plugin extension authors (omm operators), host integrators

## Why

Operators and downstream integrations need a way to react to omm lifecycle
events — log to a custom telemetry sink, enforce policy, push notifications,
mirror state to an external store — without modifying omm itself.

omm exposes a file-based hook system: drop a JS module into a per-event
directory, omm loads it on every event and calls your handler with the
event args.

## Hook Directory Layout

```
{stateRoot}/
  hooks/
    session_start/
      log-to-graylog.mjs
      ping-uptime.mjs
    session_end/
      flush-metrics.mjs
    before_tool_call/
      audit.mjs
    after_tool_call/
      mirror-to-s3.mjs
    llm_input/
    llm_output/
    agent_end/
    subagent_spawning/
    subagent_spawned/
    subagent_ended/
    gateway_start/
    gateway_stop/
    before_compaction/
    after_compaction/
```

The default `stateRoot` resolves via `resolveOmmStateRoot()`. Override per
plugin install via `OmmPluginApi.config.stateRoot`.

## Hook Module Shape

A hook module must export `event` (string matching the directory name) and
`handler` (async function receiving the event args).

```js
// {stateRoot}/hooks/session_start/log-to-graylog.mjs
export const event = "session_start";

export async function handler(args) {
  // args is whatever the host passed when emitting the event.
  // For session_start typical args: { sessionId, timestamp, ... }
  await fetch("https://graylog.example.com/gelf", {
    method: "POST",
    body: JSON.stringify({ event: "omm.session_start", ...args }),
  });
}
```

Modules with mismatched `event` values, missing exports, or wrong types
are reported as load issues but do not abort dispatch — surviving hooks
still run.

## Supported Events

| Event                | When Emitted                                               | Typical args                                          |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `session_start`      | Host begins an omm-aware session                           | `{ sessionId, timestamp }`                            |
| `session_end`        | Host ends an omm-aware session                             | `{ sessionId, timestamp, reason? }`                   |
| `before_tool_call`   | Before any tool executes (auto-trace recorded)             | `{ toolName, params, toolCallId, runId }`             |
| `after_tool_call`    | After tool returns (auto-trace recorded)                   | `{ toolName, result, durationMs, toolCallId, error }` |
| `llm_input`          | Before model call (auto-trace recorded)                    | `{ provider, model, runId, sessionId }`               |
| `llm_output`         | After model response (auto-trace recorded)                 | `{ provider, model, usage, runId, sessionId }`        |
| `agent_end`          | Agent run completes (auto-trace recorded)                  | `{ success, durationMs, sessionId }`                  |
| `subagent_spawning`  | Subagent is about to spawn                                 | `{ childSessionKey, agentId, mode }`                  |
| `subagent_spawned`   | Subagent has started running                               | `{ childSessionKey, agentId, runId }`                 |
| `subagent_ended`     | Subagent has finished                                      | `{ targetSessionKey, reason, outcome }`               |
| `gateway_start`      | OpenClaw gateway starts                                    | `{ port }`                                            |
| `gateway_stop`       | OpenClaw gateway stops                                     | `{ reason? }`                                         |
| `before_compaction`  | Host is about to compact the context window                | `{ messageCount, tokenCount?, compactingCount? }`     |
| `after_compaction`   | Host has finished compacting the context window            | `{ messageCount?, sessionId? }`                       |

The exact payload depends on the host's emitter. omm passes the args
through verbatim to user hook handlers.

## Error Semantics

- **Hook module load failures** (missing exports, wrong types, bad path)
  are collected as `loadIssues` and skipped. Dispatch proceeds with the
  hooks that loaded successfully.
- **Hook handler errors** are collected as `errors` in the dispatch
  outcome. Other hooks for the same event still run.
- **No errors propagate to the host.** A user-installed hook cannot crash
  the omm event emission path. omm's lifecycle behavior (session record
  writes, plugin tool execution) is unaffected by hook failures.

This intentionally trades observability of individual hook errors for
host stability. Hook authors should add their own logging if they need
visibility into handler failures.

## Programmatic API

omm-plugin exports `dispatchOmmHooks(event, args, config?)` for hosts that
want to wire their own dispatchers:

```ts
import { dispatchOmmHooks } from "omm-plugin/dist/src/omm-hooks.js";

await dispatchOmmHooks("after_tool_call", {
  toolName: "omm_state_write",
  durationMs: 12,
  toolCallId: "toolu_abc",
});
```

## Stability Policy

- **Patch versions (0.3.x → 0.3.y):** Event names, arg shapes, directory
  layout unchanged.
- **Minor versions (0.3 → 0.4):** New event names may be added. Existing
  events keep their arg shapes (additive only).
- **Major versions (0.x → 1.x):** Event names or arg shapes may change
  with at least one minor-version overlap before removal.

## Host Integration Checklist

For OpenClaw / MatrixAssistant / other hosts wiring lifecycle events:

1. Provide `api.on(event, handler)` in the `OmmPluginApi` passed to omm's
   `register()`.
2. Emit the events above with consistent arg shapes.
3. Test that hook directories under `{stateRoot}/hooks/` are loaded by
   inspecting omm trace MCP for `hook.invoke` events (if observability
   metrics are enabled — see roadmap.md P2).

omm's `omm-register.ts` already calls `api.on(event, …)` for all 14 events
defensively; hosts only need to implement `api.on()` itself.

Events `before_tool_call`, `after_tool_call`, `llm_input`, `llm_output`, and
`agent_end` automatically record trace events to `{stateRoot}/trace/{sessionId}.jsonl`
when a `sessionId` is present in the event args.
