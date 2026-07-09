# @oh-my-matrix/autopilot

## 3.1.0

### Minor Changes

- [#118](https://github.com/TeFuirnever/oh-my-matrix/pull/118) [`4a774a9`](https://github.com/TeFuirnever/oh-my-matrix/commit/4a774a9625c136aa75de1a6fac8f64597ec6781b) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Enhancement B (ADR-019): inject evidence-gate failure signal into retry instructions

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

- [#119](https://github.com/TeFuirnever/oh-my-matrix/pull/119) [`c65badc`](https://github.com/TeFuirnever/oh-my-matrix/commit/c65badc48bbe505679740843b8a9590d52424546) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Enhancement C (ADR-019): conditional early-completion threshold for verifiable trusted tasks

  `MIN_TURNS_BEFORE_COMPLETE` is now per-run via `minTurnsBeforeComplete(state)`:
  returns 3 when the run has non-empty validation commands AND `trustWorkspace`
  is true; returns 2 (the historical default) otherwise. This closes the gap
  where the model could satisfy a textual "all done" signal on turn 2 before
  validation meaningfully ran — specifically on the tasks where we _can_ verify.

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

## 3.0.3

### Patch Changes

- [#104](https://github.com/TeFuirnever/oh-my-matrix/pull/104) [`bc1f3be`](https://github.com/TeFuirnever/oh-my-matrix/commit/bc1f3bea13656588bd1aefa88a3a51effb2b4caf) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot crash-recovery: checkpoint persistence + ADR-010 distribution update

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
