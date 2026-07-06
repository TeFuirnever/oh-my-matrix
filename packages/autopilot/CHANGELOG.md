# @oh-my-matrix/autopilot

## 3.0.2

### Patch Changes

- [#102](https://github.com/TeFuirnever/oh-my-matrix/pull/102) [`1655737`](https://github.com/TeFuirnever/oh-my-matrix/commit/1655737fd454112f8a90370ec5b85f0379e5b64d) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot model routing: INT-3 child-declared-model-wins + LOW cleanup

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

## 3.0.1

### Patch Changes

- [#94](https://github.com/TeFuirnever/oh-my-matrix/pull/94) [`10416bf`](https://github.com/TeFuirnever/oh-my-matrix/commit/10416bf7cb018de13d512fe5a7072cb101992ca1) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Introduce Changesets for automated versioning and publishing. No package behavior changes — this is tooling only (ADR-010 follow-up [#1](https://github.com/TeFuirnever/oh-my-matrix/issues/1)).

- Updated dependencies [[`10416bf`](https://github.com/TeFuirnever/oh-my-matrix/commit/10416bf7cb018de13d512fe5a7072cb101992ca1)]:
  - @oh-my-matrix/permission-policy@0.1.2
