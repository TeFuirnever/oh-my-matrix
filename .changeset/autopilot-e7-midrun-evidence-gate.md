---
"@oh-my-matrix/autopilot": minor
---

Autopilot: mid-run evidence gate — run validation every N turns, not just on `complete` (E7 / P0-4 放大因素).

- The revise path now runs the configured validation commands every N turns (`midrun_validation_interval`, default 5; 0 disables), turning "find out it's all wrong at the very end" into early correction.
- Reuses the existing `runValidationCommands` + `evaluateEvidence` — no new execution path.
- A mid-run failure does **not block** (still `revise`); the failed commands' stderr is appended to the revise instruction so the model fixes before continuing.
- Throttled by **turn count** (`totalContinuations % N === 0`), not time — validation is slow, time-based throttling would compound on slow commands.
- Marks `inFlightToolStartedAt` during the mid-run run so the E6 stall patrol's inflight guard covers it (no false-stall, no TOCTOU with the evidence gate).

N≥5 recommended: smaller N collides with the E2 wall-clock cap (validation adds latency each cycle). Only fires when validation commands are configured AND the workspace is trusted (the existing trust boundary applies).
