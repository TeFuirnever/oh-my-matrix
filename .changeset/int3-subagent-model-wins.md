---
"@oh-my-matrix/autopilot": patch
---

Autopilot model routing: INT-3 child-declared-model-wins + LOW cleanup

Resolves INT-3 (boundary doc §5.4): a subagent's own declared model
(`ctx.modelId`, surfaced by the host before the hook fires) now wins
over the parent run's `subagentTier`. The parent tier becomes a fallback
for subagents that declared nothing. Main-agent routing and the
`modelIds`-unconfigured escape hatch are unchanged. See ADR-017.

- `before_model_resolve`: child-first guard — subagent + `ctx.modelId`
  returns no override (inherit child model).
- L1 (trust boundary): an untrusted workspace's `model_routing` is now
  dropped alongside `validation.commands`, so an attacker-controlled
  workspace cannot force a different/cheaper model tier.
- L2 (DRY): extract `findRunBySessionOrParent()` helper (was duplicated
  in `before_model_resolve` and `llm_output`).
- L3 (drift guard): phase-detection alignment tests lock the invariant
  shared by `resolveThinkingIntensity` and `resolveModelTier`.
- L5 (defensive): `buildEffortInjection` switch gains `default: null`.

Test hardening (freezes previously untested seams; no logic in M1/L7):
- M1: `before_model_resolve` hook end-to-end coverage (8 scenarios).
- INT-3: 3 new hook scenarios (child-wins, parent fallback, main-agent).
- L7: `model_routing` WORKFLOW.md parsing (5 cases incl. nested
  `model_ids`).

Suite 797 → 806 passed; typecheck 0 error; eslint clean.
