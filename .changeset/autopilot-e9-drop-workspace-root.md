---
"@oh-my-matrix/autopilot": major
---

Autopilot: remove the `workspace.root` WORKFLOW.md config field (E9 / P2-15, ADR-008).

**Breaking (schema):** `workspace.root` is removed from `WorkflowConfig.workspace`. The field was never consumed at runtime (autopilot delegates worktree management to the host per ADR-008), so there is no functional behavior change — but the type/contract change is breaking for TS consumers and WORKFLOW.md authors.

**Migration:** if your `WORKFLOW.md` sets `autopilot.workspace.root`, remove that line. The parser now emits a deprecation warning (`workspace.root is no longer supported … — remove this line from WORKFLOW.md`) and ignores the value, so existing files keep working (no crash) — just drop the line to clear the warning.

Note: `state.workspace.root` on `WorkspaceRecord` (the checkpoint root, P0-2/E1) is a **different field** and is unchanged — crash-recovery / checkpoint read-write is unaffected.

This release also bundles the pending minor features (E2 hard caps, E3 error classification, E5 progress ledger) under this major bump.
