---
"@oh-my-matrix/autopilot": patch
---

`autopilot.list_resumable_sessions` now also broadcasts one `sessions.changed` per advertised session on the request's own gateway context (方案 B, MA X3).

An init-time push after crash-recovery is physically impossible: no `GatewayRequestContext` exists at plugin activate, and no client is connected yet (the gateway's own emitter no-ops on zero subscribers). So the push rides the host's first pull — the same request context that answers the RPC broadcasts the events, delivering restored-run state on the canonical `sessions.changed` path MA already consumes (`pluginExtensions.autopilot` shape, mirroring what the gateway's emitter spreads from `sessionRow.pluginExtensions`).

- Payload per session: `sessionKey`, `ts`, and `pluginExtensions.autopilot` carrying `status`, `needsCrossTurnResume`, `totalContinuations`, `maxTotalContinuations`, and `lastActivityAt` when present — the host-side resume guard needs `totalContinuations` as a finite number or it skips the run.
- The response list and the broadcast list are the same array: exactly the advertised (sessionKey-present, enabled, active-orchestration) sessions. Guards unchanged.
- Data, not a kick: "Continuation is now EXPLICIT" semantics untouched; a host re-poll is deduped host-side by idempotencyKey. Stall fallback untouched.
- The RPC response gains the same two additive fields (`maxTotalContinuations`, `lastActivityAt`).
