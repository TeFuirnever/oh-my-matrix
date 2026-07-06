---
"@oh-my-matrix/autopilot": patch
---

Autopilot crash-recovery: checkpoint persistence + ADR-010 distribution update

Run state was previously pure in-memory — a Gateway restart lost all runs,
including long-running tasks mid-execution. This adds a crash-recovery layer:
a slim checkpoint written at stable state transitions to
`{workspace}/.autopilot/checkpoints/{runId}.json`, restored on process init.

- New `src/state-persister.ts`: synchronous, fail-silent, atomic-write
  checkpoint module (mirrors permission-policy's audit-persister pattern).
  Per-runId Promise lock serializes concurrent writes. Same-directory tmp
  rename avoids Windows EXDEV.
- `index.ts` wiring: `setState` persists at orchState / blockedReason /
  evidence / goal / progress / enabled transitions (not per-token-batch).
  `register()` restores all resumable runs at process init.
  `session_start` / `session_end` maintain a durable sessionKey→runId index
  so the in-memory Map being empty after restart no longer loses runs.
- ADR-016 status sole-writer invariant preserved: `status` is NEVER trusted
  from disk — `loadCheckpoint` re-derives via `deriveStatus` on every restore.
- State reconstruction fidelity: `workspace` / `retry` / `workflow` are
  persisted + restored so a recovered run retains its permission containment
  boundary, can resume `retry_queued` state, and does not skip validation.
- Terminal runs (done / user_stopped) delete their checkpoint; a 24h sweep
  reclaims stale terminal checkpoints.
- Tests: 25 persister unit tests + 5 wiring integration tests covering
  setState→checkpoint, register() restore across a simulated restart,
  session_end survival, and done-run cleanup. 836 passed / 4 skipped.

Also updates ADR-010 and AGENTS.md to reflect that the npm registry is now
the primary distribution path (the release pipeline landed since ADR-010 was
written); the offline `file:` tgz path remains as a host-vendoring option.

Known limitations (documented in README):
- checkpoint root defaults to `process.cwd()`; non-cwd deployments need a
  `checkpointRoot` pluginConfig override (future work)
- `totalTokensUsed` is checkpointed at transitions only; budget enforcement
  is best-effort across a single-turn staleness window

Residual risk: real `session_start` event shape not captured against a live
host — the AGENTS.md deployed-dist smoke check (restart a real OpenClaw
session, verify the resume path hits) is required before production-live.
