---
'@oh-my-matrix/autopilot': minor
---

Enhancement C (ADR-019): conditional early-completion threshold for verifiable trusted tasks

`MIN_TURNS_BEFORE_COMPLETE` is now per-run via `minTurnsBeforeComplete(state)`:
returns 3 when the run has non-empty validation commands AND `trustWorkspace`
is true; returns 2 (the historical default) otherwise. This closes the gap
where the model could satisfy a textual "all done" signal on turn 2 before
validation meaningfully ran — specifically on the tasks where we *can* verify.

To support this, `trustWorkspace` is now carried on `AutopilotState` (stamped
at activate from the effective `payload ?? config ?? false` decision) and
persisted through the `AutopilotCheckpoint` allowlist (3 edits in
state-persister.ts) — without the allowlist entry, a crashed trusted-verifiable
run would silently degrade threshold 3 to 2 on recovery.

Tradeoff (non-eliminable): raising the threshold delays legitimate fast
completion of trusted-verifiable tasks by one turn. Accepted — preventing
false completion on verifiable tasks is worth a one-turn happy-path delay.

Backward compatible: runs without validation commands, without trustWorkspace,
or resumed from pre-Enhancement-C checkpoints all keep threshold 2. ADR-016
sole-writer preserved (no status writes; threshold only shapes the
revise/complete branch condition).
