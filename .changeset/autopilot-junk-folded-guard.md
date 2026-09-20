---
"@oh-my-matrix/autopilot": patch
---

Guard both ledger-folded spread sites against non-object values (MA cross-review finding 3).

A corrupt checkpoint with `ledger.folded` set to a non-object (e.g. the string `"oops"`) hit two spreads that expanded it by character index into junk keys (`0:'o'..3:'s'`). The junk originated in migrateCheckpoint's v1 branch (`{ ...folded, lastValidatedTurn: 0 }`), which turned the string into a valid-looking object that 4.5.2's `normalizeLedger` then preserved under its extra-fields contract; `normalizeLedger`'s own `...(l.folded ?? {})` spread had the same hole. The junk did not crash (consumers read named keys only), but buildCheckpoint persisted it back on every save — permanently polluting the checkpoint, contrary to the normalization's contract for corrupt input.

Both sites now type-guard: a non-object (or array) `folded` falls to the complete empty shape. `folded: "oops"` restores to exactly the four named keys, and the ledger to exactly `folded`+`entries`.
