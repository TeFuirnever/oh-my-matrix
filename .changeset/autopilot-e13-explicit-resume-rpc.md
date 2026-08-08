---
"@oh-my-matrix/autopilot": major
---

Autopilot: explicit `resume_run` RPC replaces the implicit crash-recovery auto-kick (E13 / P3-29).

**Breaking (default flip):** crash-recovery no longer auto-kicks a restored mid-cross-turn run (`needsCrossTurnResume`). Pre-E13, register() fired a resumed turn on restore — but that implicit "flag → turn" link double-spent a turn after a gateway restart (openclaw's in-memory dedup clears on restart, so the same idempotency key was accepted again). Continuation is now **explicit**: the driver/host calls the new `autopilot.resume_run` RPC once to resume.

- New gateway method `autopilot.resume_run` ({ sessionKey }) — validates the run is mid-cross-turn (`needsCrossTurnResume`) and active, then drives the resumed turn via `kickResumedTurn`. Returns `{ ok, runId }`.
- `needsCrossTurnResume` stays as a **state fact** (the run is mid-cross-turn); only the implicit "re-broadcast → turn" link is cut.
- The idempotency-key derivation (from `totalContinuations`) is preserved + anchored in a comment.

**Migration / cross-repo dependency:** existing hosts that relied on the restore-time auto-continue now see restored mid-cross-turn runs sit until `resume_run` is called (the stall path remains a slow fallback after `stallTimeout`). **Full no-double-spend requires the MA driver to consume `resume_run`** — that MA-side change is out of OMM scope (cross-repo), tracked as a dependency.

This release also bundles the pending E2/E3/E5 minors under this major (E9's major already initiated the major line).
