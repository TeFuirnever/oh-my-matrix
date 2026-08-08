---
"@oh-my-matrix/autopilot": minor
---

Autopilot: structured progress ledger, replacing the "Turn N/M completed" counter (E5 / P1-11 + P1-13).

- New `src/progress-ledger.ts`: per-turn `LedgerEntry` (filesTouched, commandsRun,
  evidenceStatus, decisions, openItems) with capacity-controlled folding. Older
  turns fold into a merged aggregate (replace, not stack); the last N stay as
  detail. `summarizeLedger` emits a compact structured JSON (folded + recent +
  open surfaces).
- Data-source precision: `filesTouched` comes ONLY from write-class tools
  (`workspace_write`/`system_write`) via `after_tool_call`; `commandsRun` ONLY
  from exec-class (`validation`/`destructive_git`/`unknown`). Read-only calls
  record nothing — a pure-analysis run no longer looks "active" (the E6
  no-progress signal depends on this).
- Subagent tool activity merges up to the parent run via the existing parent
  session-key lookup — observation only, no permission path touched.
- The ledger rides `AutopilotState` (→ checkpoint at the E1-unified
  `getCheckpointRoot`); no second persistence mechanism. It survives compaction
  and crash recovery.
- Consumers (`agent_turn_prepare` injection + `buildRetryInstruction`) now emit
  the ledger summary instead of the counter, preferring the ledger over a stale
  post-compaction `progressSnapshot`. The post-compaction re-injection is handled
  by the next turn's `agent_turn_prepare` (the ledger lives in state, untouched by
  context compaction).
- Known limitation (documented in code): the `decisions`/`openItems` fields are
  left empty for now (the model does not yet populate them); the "doing/not-started"
  3-state is therefore aspirational — the ledger currently surfaces "done" (from
  activity) only.
