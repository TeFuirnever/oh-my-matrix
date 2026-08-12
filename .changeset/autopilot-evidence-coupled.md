---
"@oh-my-matrix/autopilot": minor
---

Evidence-coupled no_progress accounting + checkpoint schemaVersion + F3/F6 fixes (loopx enhancement line, tickets 02/08/12).

## New capabilities

- **Evidence-coupled no_progress (ticket 02):** new `lastProgressTurn(ledger)` export counts only turns whose evidence counts as forward progress — a run churning files that never passes validation still trips no_progress. A run whose validator never actually ran (`skipped`+`not_executed`) no longer reads as progress (F6).
- **Checkpoint schemaVersion (ticket 08):** `AutopilotCheckpoint.schemaVersion` + `migrateCheckpoint()` v1→v2 hook. Legacy checkpoints are normalized on load (folded `lastValidatedTurn` backfill + full `EvidenceSummary` restored, was lost pre-08 — crash recovery no longer blanks projection/continuation-engine). Future-version checkpoints (> current) are refused, not silently misread.
- **Migration grace (F3):** `Ledger.progressGrace` transient + `hasMigrationGrace()` / `consumeMigrationGrace()` — a one-shot flag set on migrated legacy ledgers so a resumed run with unreconstructable progress history does not trip no_progress on the first patrol tick.

## Host integration prerequisites (IMPORTANT)

02's regressions (F1 stale `'failed'` stamping, F2 audit-refcount over-release, F3 host grace wiring) live in the **host gateway** `index.ts` (agent_end / patrol / setAuditMode), NOT in this package. The package code is clean and safe to consume. **But before the host activates evidence-coupled no_progress** (i.e. switches its patrol detector to call `lastProgressTurn` and stamps agent_end entries with evidence status), the host MUST:

1. Fix F1 — only stamp an agent_end entry's evidenceStatus when the gate actually ran this turn (revise turns stamp `undefined`, not stale `state.evidence.status`).
2. Fix F2 — guard audit-refcount release on the reducer result at the no_progress pause site (a no-op pause must not release).
3. Consume F3 grace — patrol checks `hasMigrationGrace(ledger)`, suppresses one no_progress pause, then calls `consumeMigrationGrace`.

Until the host does this, 02's `lastProgressTurn` is a dormant exported API — consuming this version without activating it is harmless. 08 (checkpoint migration + evidence restore) benefits the host immediately on upgrade with no host-side change.

## Semantic decisions

- F6: `skipped`+`not_configured` (no validation configured) still counts as progress; only `skipped`+`not_executed` (configured but dropped/errored, fail-closed per evidence-gate) does not. This avoids false-pausing the majority of projects that run without validation configured.
