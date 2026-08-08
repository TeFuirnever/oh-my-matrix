---
"@oh-my-matrix/autopilot": minor
---

Autopilot: add hard caps (wall-clock + cost) and redo error classification (E2 + E3, same-batch).

**E2 — wall-clock + cost hard caps (P0-5):**
- New optional config `maxDurationMs` / `maxCostUsd` (plugin config, carried onto run
  state + persisted for crash recovery).
- Caps enforced in the 60s patrol (the only site that can intervene mid-turn —
  `before_agent_finalize` doesn't fire on API errors). Producing runs get one
  controlled-winddown turn to summarize, then terminate; runs not in a model turn
  (e.g. `retry_queued`) stop immediately.
- New `hard_stop_requested` reducer event bypasses TENSION 3: unlike
  `pause_requested` (which no-ops off the running family so a recoverable breaker
  survives a pause), a spent budget terminates from any active state including
  `retry_queued`.
- New non-resumable reasons `max_duration_reached` / `max_cost_reached`, synced
  across all four sites (PauseReason / BlockedReason / pauseReasonToBlockedReason /
  VALID_BLOCKED_REASONS).
- Cost calc extracted to `src/cost.ts` (`computeCostUsd`), shared by projection and
  the cap enforcer.
- Known limitation (documented in code): the cost cap is a no-op when the host
  doesn't report token usage (`totalTokensUsed` stays 0) — not a hard guarantee.

**E3 — error classification redo (P0-3):**
- `classifyRecoverability` rewritten as an explicit table: structured HTTP status
  / errno codes first, anchored string match as fallback. Rate-limit (429) and
  overload (529) are recoverable with a long backoff tier and honored Retry-After;
  network errno (ECONNRESET/ETIMEDOUT/EPIPE/…) recoverable; auth (401/403) and
  permission non-recoverable.
- Fixes bidirectional misclassification: a bare `timeout` substring no longer
  auto-recovers (network errno ETIMEDOUT does), and a `tokenizer` error no longer
  hits the budget branch (anchored `token_budget`/`budget` does).
- Retry backoff gains ±20% jitter (`WorkflowConfig.retryJitter`, default 0.2) to
  de-synchronize concurrent runs retrying the same upstream outage.
- Tiered retry guidance: low retry counts nudge "fix and retry"; at/above attempt 3
  the instruction forces a fundamentally different approach or stopping to report.
- Known limitation (documented in code): the spec's context-overflow "recoverable
  exactly once" cap is not enforced (the classifier is stateless) — deferred.
