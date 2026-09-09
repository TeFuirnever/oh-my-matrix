---
"@oh-my-matrix/autopilot": patch
---

Fix `stop_requested` no-op on paused runs. The reducer's `stoppable` list omitted `'blocked'`, so stopping a paused session (blocked + non-`user_stopped` reason, e.g. `max_retries_reached` / `tool_error_repeated` / `loop_breaker_triggered`) returned the state unchanged while the `autopilot.stop` gateway method still reported `ok: true`. With resume restricted to resumable reasons and activate rejecting `paused`, such sessions were permanently stuck — the only escape was a gateway restart. `blocked` is now stoppable (matching the design-doc transition `blocked --> idle: stop_requested`), transitioning to `blocked`/`user_stopped` which derives to `status: 'idle'`; stopping an already-`user_stopped` run remains a no-op (same exemption as `hard_stop_requested`).
