---
"@oh-my-matrix/autopilot": minor
---

Autopilot: stall detection双向 fix — inflight tool guard + productivity/no-progress detection (E6 / P0-6 + P1-14).

**dir-1 — inflight tool guard (fixes false-stall on long tools, P0-6 误报 + P1-14):**
- New `inFlightToolStartedAt` state field, set when a tool dispatches (`before_tool_call`, allow-path) and during validation (`complete` path). While set, the 60s stall patrol uses a longer per-tool cap (30min, `INFLIGHT_TOOL_CAP_MS`) instead of `stallTimeoutMs`, so a legitimately long build/test no longer false-stalls at 300s. A genuinely hung tool still trips at the cap.
- Cleared on `after_tool_call`, `agent_end`, and `before_agent_finalize` so a dangling field (the model finalized mid-tool, or a crash) can't permanently relax stall detection.

**dir-2 — productivity/no-progress detection (fixes missed spin, P0-6 漏报):**
- New `no_progress` PauseReason/BlockedReason (resumable, like `stalled`). When a run takes N consecutive turns with zero files-touched/commands-run (configurable via `no_progress_turns`, default 3), the patrol pauses it — catching read-only loops and A→B→A→B churn that pure-silence detection misses.
- The signal is exec-class-filtered ledger activity (E5's ledger already records only write/exec tools, never read-only) — a pure-analysis run records nothing, so no_progress can fire. Fail-open: no ledger / 0 threshold → skip.

Known: `no_progress` is also added to `RESUMABLE_BLOCKED_REASONS` (recoverable via a user resume/nudge, like `stalled`).
