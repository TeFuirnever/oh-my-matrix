---
'@oh-my-matrix/autopilot': minor
---

Enhancement B (ADR-019): inject evidence-gate failure signal into retry instructions

When the Evidence Gate fails (a required validation command returns non-zero
or times out), the retry instruction now re-surfaces the failed commands'
stderr summaries and the failure reason into the next turn's injection. This
gives the model an explicit correction signal — most valuable after compaction
may have evicted the original tool stderr from the context window.

The command `summary` (which carries stderr from `command-runner.ts`) is the
payload; `failureReason` is included as decoration. Up to 2 failed commands are
reported. The closing "Continue from where you left off." line is always
preserved even when goal + progress consume most of the 2000-char budget.

No change to behavior when evidence is absent, passed, or skipped — fully
backward compatible. Pure-function only; no new OrchestratorEvent, no status
writes (ADR-016 sole-writer invariant preserved).
