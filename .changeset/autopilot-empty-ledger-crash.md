---
"@oh-my-matrix/autopilot": patch
---

Fix gateway crash loop on restoring a checkpoint whose ledger folded down to `{}` (MA runtime report).

`loadCheckpoint` loaded `cp.ledger` verbatim. A checkpoint whose ledger had folded/cleaned down to an empty object restored as-is, and the stall patrol (`folded.lastValidatedTurn`) and the resume_run injection (`entries.map`) hit properties of `undefined` inside a timer callback — taking the whole gateway process down every ~64s until the checkpoint was repaired.

- `normalizeLedger` (new): a complete ledger passes through unchanged; an empty/partial object gets `entries`/`folded` defaults; unknown extra fields (e.g. migrateCheckpoint's one-shot `progressGrace` flag) are preserved. `loadCheckpoint` applies it on restore.
- `coerceLedger` (new, depth defense): all four public progress-ledger functions upgraded from a bare `?? emptyLedger()` — which only caught `undefined`, not `{}` — so no single malformed field can crash the gateway process again.
- schemaVersion stays 2: the shape is backward-compatible, and a complete ledger survives normalization untouched.
