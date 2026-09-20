# @oh-my-matrix/autopilot

## 4.5.3

### Patch Changes

- [`28a12ea`](https://github.com/TeFuirnever/oh-my-matrix/commit/28a12eaaa9efd4d14d06fa8643b8a8edc1d8678a) - Guard both ledger-folded spread sites against non-object values (MA cross-review finding 3).

  A corrupt checkpoint with `ledger.folded` set to a non-object (e.g. the string `"oops"`) hit two spreads that expanded it by character index into junk keys (`0:'o'..3:'s'`). The junk originated in migrateCheckpoint's v1 branch (`{ ...folded, lastValidatedTurn: 0 }`), which turned the string into a valid-looking object that 4.5.2's `normalizeLedger` then preserved under its extra-fields contract; `normalizeLedger`'s own `...(l.folded ?? {})` spread had the same hole. The junk did not crash (consumers read named keys only), but buildCheckpoint persisted it back on every save — permanently polluting the checkpoint, contrary to the normalization's contract for corrupt input.

  Both sites now type-guard: a non-object (or array) `folded` falls to the complete empty shape. `folded: "oops"` restores to exactly the four named keys, and the ledger to exactly `folded`+`entries`.

## 4.5.2

### Patch Changes

- [`231049e`](https://github.com/TeFuirnever/oh-my-matrix/commit/231049e5468ddde07183c0f570cf3e48fc05ce11) - Fix gateway crash loop on restoring a checkpoint whose ledger folded down to `{}` (MA runtime report).

  `loadCheckpoint` loaded `cp.ledger` verbatim. A checkpoint whose ledger had folded/cleaned down to an empty object restored as-is, and the stall patrol (`folded.lastValidatedTurn`) and the resume_run injection (`entries.map`) hit properties of `undefined` inside a timer callback — taking the whole gateway process down every ~64s until the checkpoint was repaired.

  - `normalizeLedger` (new): a complete ledger passes through unchanged; an empty/partial object gets `entries`/`folded` defaults; unknown extra fields (e.g. migrateCheckpoint's one-shot `progressGrace` flag) are preserved. `loadCheckpoint` applies it on restore.
  - `coerceLedger` (new, depth defense): all four public progress-ledger functions upgraded from a bare `?? emptyLedger()` — which only caught `undefined`, not `{}` — so no single malformed field can crash the gateway process again.
  - schemaVersion stays 2: the shape is backward-compatible, and a complete ledger survives normalization untouched.

## 4.5.1

### Patch Changes

- [`98ee107`](https://github.com/TeFuirnever/oh-my-matrix/commit/98ee107b0173778651a9a63fd5ca5067a254f9b0) - `autopilot.list_resumable_sessions` now also broadcasts one `sessions.changed` per advertised session on the request's own gateway context (方案 B, MA X3).

  An init-time push after crash-recovery is physically impossible: no `GatewayRequestContext` exists at plugin activate, and no client is connected yet (the gateway's own emitter no-ops on zero subscribers). So the push rides the host's first pull — the same request context that answers the RPC broadcasts the events, delivering restored-run state on the canonical `sessions.changed` path MA already consumes (`pluginExtensions.autopilot` shape, mirroring what the gateway's emitter spreads from `sessionRow.pluginExtensions`).

  - Payload per session: `sessionKey`, `ts`, and `pluginExtensions.autopilot` carrying `status`, `needsCrossTurnResume`, `totalContinuations`, `maxTotalContinuations`, and `lastActivityAt` when present — the host-side resume guard needs `totalContinuations` as a finite number or it skips the run.
  - The response list and the broadcast list are the same array: exactly the advertised (sessionKey-present, enabled, active-orchestration) sessions. Guards unchanged.
  - Data, not a kick: "Continuation is now EXPLICIT" semantics untouched; a host re-poll is deduped host-side by idempotencyKey. Stall fallback untouched.
  - The RPC response gains the same two additive fields (`maxTotalContinuations`, `lastActivityAt`).

## 4.5.0

### Minor Changes

- [`f6aeb17`](https://github.com/TeFuirnever/oh-my-matrix/commit/f6aeb178bac16aaad5d4204f2055bb57ccc5b185) - Wire the task-size classifier into effort and model routing (ticket-04).

  `classifyTaskSize` already ran on every `setGoal`, but its `taskTier` output only
  reached `resolveThinkingIntensity` and was ignored by model routing entirely.
  Both consumers now read it:

  - **Effort** (`effort-injection.ts`): on continuation turns (`totalContinuations >= 2`),
    `small` caps at medium effort and `large` pins to high. `small` still yields to an
    explicit `configIntensity: 'low'` so operator cost controls are not silently overridden.
    Initial turns and the validation phase are unchanged — both still win over the tier.
  - **Model** (`model-routing.ts`): `large` reuses `initialTurnTier` on continuation turns
    instead of falling to the weaker `defaultTier` mid-execution. This is config-driven by
    design; there is deliberately no hardcoded `premium` floor, so an operator who lowers
    `initialTurnTier` opts out of premium everywhere.
  - **Projection** (`projection.ts`): passes `taskTier` to `resolveModelTier` so the
    projected `modelTier` matches the override actually emitted to the gateway. Previously
    dashboards read `standard` while a large task ran on premium.

  Also fixes two crash-recovery defects found while reviewing the above:

  - `isActiveOrchestrationState` derived its active-state set from a hand-maintained list
    that would silently drift from `deriveStatus`; it now delegates to `deriveStatus`.
  - `autopilot.list_resumable_sessions` now skips entries with an undefined `sessionKey`
    (partially-written checkpoint) or `enabled: false` (crash mid-deactivation), either of
    which would strand a run on the host side.

## 4.4.1

### Patch Changes

- [`013f225`](https://github.com/TeFuirnever/oh-my-matrix/commit/013f225cea3b5a6fa4f475f6e60199dc0bf32aec) - Fix `stop_requested` no-op on paused runs. The reducer's `stoppable` list omitted `'blocked'`, so stopping a paused session (blocked + non-`user_stopped` reason, e.g. `max_retries_reached` / `tool_error_repeated` / `loop_breaker_triggered`) returned the state unchanged while the `autopilot.stop` gateway method still reported `ok: true`. With resume restricted to resumable reasons and activate rejecting `paused`, such sessions were permanently stuck — the only escape was a gateway restart. `blocked` is now stoppable (matching the design-doc transition `blocked --> idle: stop_requested`), transitioning to `blocked`/`user_stopped` which derives to `status: 'idle'`; stopping an already-`user_stopped` run remains a no-op (same exemption as `hard_stop_requested`).

## 4.4.0

### Minor Changes

- [#152](https://github.com/TeFuirnever/oh-my-matrix/pull/152) [`34bf432`](https://github.com/TeFuirnever/oh-my-matrix/commit/34bf432e7569e6481b1a63bfc4c485cf0d1fa2e0) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Evidence-coupled no_progress accounting + checkpoint schemaVersion + F3/F6 fixes (loopx enhancement line, tickets 02/08/12).

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

## 4.3.0

### Minor Changes

- task-size classifier: goal classified into trivial/small/standard/large at
  capture time; trivial tasks get low thinking effort for the first 3
  continuuations (auto-escalate after). Conservative — only downgrades trivial.

## 4.2.0

### Minor Changes

- [`bdf4815`](https://github.com/TeFuirnever/oh-my-matrix/commit/bdf4815c55ec5652a00f250b259da8280dc0702e) - AC-NNN predicates: goal can carry an embedded acceptance-criteria block
  (Scenario/Action/Expected/Must-not/Verification/Priority). Both injection
  sites (agent_turn_prepare + retry instruction) render the intent + compact
  AC list; MAX_GOAL_LENGTH raised 500→2000 to fit an AC block. Backward
  compatible — a free-text goal parses to [] and behaves as before.

## 4.1.0

### Minor Changes

- autopilot: evidence gate fail-closed completion (timeout/missing/dropped
  required commands → blocked evidence_missing, resumable), resume hardening
  (pauseReason cleared, facade pre-check, no resume_run double-kick, retry chain
  preserved), completionUnverified only on done runs, S8 audit refcount balanced
  across all terminal paths.

  dynamic-workflows: replace the 14 hand-adapted role prompts with 19 agent
  prompts ported verbatim from oh-my-claudecode (OMC-only references stripped);
  patterns/templates/test-prompts updated to the new role set.

## 4.0.0

### Major Changes

- [#141](https://github.com/TeFuirnever/oh-my-matrix/pull/141) [`80abedf`](https://github.com/TeFuirnever/oh-my-matrix/commit/80abedff44bb10560110f67a446adcb9564606dc) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot: explicit `resume_run` RPC replaces the implicit crash-recovery auto-kick (E13 / P3-29).

  **Breaking (default flip):** crash-recovery no longer auto-kicks a restored mid-cross-turn run (`needsCrossTurnResume`). Pre-E13, register() fired a resumed turn on restore — but that implicit "flag → turn" link double-spent a turn after a gateway restart (openclaw's in-memory dedup clears on restart, so the same idempotency key was accepted again). Continuation is now **explicit**: the driver/host calls the new `autopilot.resume_run` RPC once to resume.

  - New gateway method `autopilot.resume_run` ({ sessionKey }) — validates the run is mid-cross-turn (`needsCrossTurnResume`) and active, then drives the resumed turn via `kickResumedTurn`. Returns `{ ok, runId }`.
  - `needsCrossTurnResume` stays as a **state fact** (the run is mid-cross-turn); only the implicit "re-broadcast → turn" link is cut.
  - The idempotency-key derivation (from `totalContinuations`) is preserved + anchored in a comment.

  **Migration / cross-repo dependency:** existing hosts that relied on the restore-time auto-continue now see restored mid-cross-turn runs sit until `resume_run` is called. The stall path remains a fallback that can re-fire a turn after `stallTimeout` (retry_due advances the idempotency key, but a second turn can still run if the pre-restart turn also executed) — it is NOT a benign no-op. **Deterministic single-resume + full no-double-spend requires the MA driver to consume `resume_run`** — that MA-side change is out of OMM scope (cross-repo), tracked as a dependency.

  This release also bundles the pending E2/E3/E5 minors under this major (E9's major already initiated the major line).

- [#140](https://github.com/TeFuirnever/oh-my-matrix/pull/140) [`f9b801c`](https://github.com/TeFuirnever/oh-my-matrix/commit/f9b801cd6b5f3e7841ee56e844350d9856dd5a45) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot: remove the `workspace.root` WORKFLOW.md config field (E9 / P2-15, ADR-008).

  **Breaking (schema):** `workspace.root` is removed from `WorkflowConfig.workspace`. The field was never consumed at runtime (autopilot delegates worktree management to the host per ADR-008), so there is no functional behavior change — but the type/contract change is breaking for TS consumers and WORKFLOW.md authors.

  **Migration:** if your `WORKFLOW.md` sets `autopilot.workspace.root`, remove that line. The parser now emits a deprecation warning (`workspace.root is no longer supported … — remove this line from WORKFLOW.md`) and ignores the value, so existing files keep working (no crash) — just drop the line to clear the warning.

  Note: `state.workspace.root` on `WorkspaceRecord` (the checkpoint root, P0-2/E1) is a **different field** and is unchanged — crash-recovery / checkpoint read-write is unaffected.

  This release also bundles the pending minor features (E2 hard caps, E3 error classification, E5 progress ledger) under this major bump.

- [`0f32fab`](https://github.com/TeFuirnever/oh-my-matrix/commit/0f32fabd55fb0a4a75f92432c501965d55e7d969) - Move the OpenClaw baseline to 2026.7.1-2 (**BREAKING** — drops 2026.5.28–2026.7.1-1):

  - peer `openclaw`: `>=2026.5.28 <2027` → `>=2026.7.1-2 <2027`. Single supported
    baseline; no back-compat range. Consumers on an older OpenClaw host stay on the
    previous plugin release (`@oh-my-matrix/autopilot@3.1.0` /
    `@oh-my-matrix/dynamic-workflows@0.2.0` on npm, plus the matching git tag) — that
    is what the historical packages and tags are for.
  - Note on the range form: `>=2026.7.1-2` (not `>=2026.7.1`) is required because
    semver treats the `-N` correction as a prerelease and excludes it from a plain
    range — `satisfies("2026.7.1-2", ">=2026.7.1")` is false under pnpm@10.24.0 +
    semver@7.8.5. The `-2` floor still admits the stable base `2026.7.1` and later
    (`2026.7.2`, …).
  - Also dropped: `extended-stable` 2026.6.33 is no longer in range. Deliberate —
    OMM tracks OpenClaw `latest`.
  - devDep/test baseline pinned `openclaw@2026.7.1-2`.
  - SDK drift: `PluginHookBeforeToolCallEvent` gained optional `toolKind` /
    `toolInputKind` / `derivedPaths` in openclaw 2026.7.1
    (`src/plugins/hook-types.ts`); refreshed stale "NO toolKind" claims across
    `event-shape.contract.ts` (both packages), both `before_tool_call` `index.ts`
    notes, the `subagent-guard.test.ts` header, and
    `docs/fixes/runtime-guard-event-shape.md`. No behavioral change — the new fields
    are unused (verified: `decidePermissionForEvent` does not forward `toolKind` into
    `classifyCommand`).

  Maintenance note: future OpenClaw corrections of a different base (e.g.
  `2026.7.2-1`, `2026.8.0-1`) will NOT match this peer form — the floor must be
  re-pinned each time OMM adopts a new correction. Inherent to OpenClaw's
  CalVer+correction scheme under semver (no `-0` trick or range variant avoids it).
  With a single-baseline policy this rebase is now the routine upgrade step.

### Minor Changes

- [#146](https://github.com/TeFuirnever/oh-my-matrix/pull/146) [`fabdad9`](https://github.com/TeFuirnever/oh-my-matrix/commit/fabdad9c8b477553bcc6fdd15a307d5683d52e1d) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot: fold the 2 remaining `needsCrossTurnResume` bare spreads into reducer events (E12 — reducer sole-writer, ADR-020).

  The last two non-reducer writers of `needsCrossTurnResume` in `index.ts` are now reducer events:

  - `cross_turn_enqueued` — the NORMAL cross-turn handshake (per-turn revise cap reached, not degraded). `totalContinuations++`, `needsCrossTurnResume:true`, `turnAttempts:0`, `lastActivityAt` advanced (the cross-turn was armed = activity). Also fixes a latent race: the state write now lands on the fresh post-await state (`stateByRun.get`) instead of a stale pre-await snapshot.
  - `cross_turn_degraded_silent` — the degraded FALLBACK (enqueue rejected/threw). Same as `cross_turn_degraded` but WITHOUT `lastActivityAt` — the canary failed (before_agent_finalize never fired = stalled); stamping activity would mask the stall from the detector (the E8 `degradation_marked` rationale). Merges `degradation_marked` + the bare spread into one event.

  This gets `needsCrossTurnResume` to **reducer-only in `index.ts`**. The sole remaining non-reducer writer is the `resume()` setter in `autopilot-state.ts`, blocked on E4 step 3 (M2 cross-repo) — the full 6-aux reducer-sole-writer invariant test stays deferred until that lands.

- [#136](https://github.com/TeFuirnever/oh-my-matrix/pull/136) [`8affbfc`](https://github.com/TeFuirnever/oh-my-matrix/commit/8affbfcb74b1da8d4b19bdb7209c915d136b9eca) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot: add hard caps (wall-clock + cost) and redo error classification (E2 + E3, same-batch).

  **E2 — wall-clock + cost hard caps (P0-5):**

  - New optional config `maxDurationMs` / `maxCostUsd` (plugin config, carried onto run
    state + persisted for crash recovery).
  - Caps enforced in the 60s patrol (the only site that can intervene mid-turn —
    `before_agent_finalize` doesn't fire on API errors). Producing runs get one
    controlled-winddown turn to summarize, then terminate; runs not in a model turn
    (e.g. `retry_queued`) stop immediately.
  - New `hard_stop_requested` reducer event bypasses TENSION 3: unlike
    `pause_requested` (which no-ops off the running family so a recoverable breaker
    survives a pause), a spent budget terminates from any active state including
    `retry_queued`.
  - New non-resumable reasons `max_duration_reached` / `max_cost_reached`, synced
    across all four sites (PauseReason / BlockedReason / pauseReasonToBlockedReason /
    VALID_BLOCKED_REASONS).
  - Cost calc extracted to `src/cost.ts` (`computeCostUsd`), shared by projection and
    the cap enforcer.
  - Known limitation (documented in code): the cost cap is a no-op when the host
    doesn't report token usage (`totalTokensUsed` stays 0) — not a hard guarantee.

  **E3 — error classification redo (P0-3):**

  - `classifyRecoverability` rewritten as an explicit table: structured HTTP status
    / errno codes first, anchored string match as fallback. Rate-limit (429) and
    overload (529) are recoverable with a long backoff tier and honored Retry-After;
    network errno (ECONNRESET/ETIMEDOUT/EPIPE/…) recoverable; auth (401/403) and
    permission non-recoverable.
  - Fixes bidirectional misclassification: a bare `timeout` substring no longer
    auto-recovers (network errno ETIMEDOUT does), and a `tokenizer` error no longer
    hits the budget branch (anchored `token_budget`/`budget` does).
  - Retry backoff gains ±20% jitter (`WorkflowConfig.retryJitter`, default 0.2) to
    de-synchronize concurrent runs retrying the same upstream outage.
  - Tiered retry guidance: low retry counts nudge "fix and retry"; at/above attempt 3
    the instruction forces a fundamentally different approach or stopping to report.
  - Known limitation (documented in code): the spec's context-overflow "recoverable
    exactly once" cap is not enforced (the classifier is stateless) — deferred.

- [#145](https://github.com/TeFuirnever/oh-my-matrix/pull/145) [`3f8323d`](https://github.com/TeFuirnever/oh-my-matrix/commit/3f8323d49d5a1467061080fc2c01901ccd78ab1b) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot: evidence-gate `skipped` distinction — not_configured vs not_executed (E4 step 1-2 / P0-4).

  **Behavior change (eval-error path):** the evidence gate used to treat every `skipped` result as `done`. It now distinguishes WHY it skipped via an explicit `skipReason` field (not a failureReason string match):

  - `not_configured` (no validation commands) → `done` (legitimate; behavior unchanged) + `completionUnverified: true`.
  - `not_executed` (configured but didn't run — the `complete`-path evaluation-error fail-open) → **`blocked` + `evidence_missing`** + `completionUnverified: true`. This is the first production write of `evidence_missing` (previously unreachable). It is resumable.

  A run that legitimately configures no validation (analysis tasks) still completes; a run that configured validation but the gate errored no longer silently "completes" — it blocks on `evidence_missing` so the operator can fix + resume.

  New `completionUnverified` state/projection marker (persisted) flags any completion that did NOT pass the evidence gate. `skipReason` defaults to `not_configured` for legacy summaries (backward-compat → done).

  **Out of scope (step 3, M2-coupled):** the `resume` guard that makes the resume button respect recoverability (`resume_requested` no-op → respond false) requires the MA-side `canResume` field (M2, cross-repo) and is NOT in this change — shipping it alone would make the resume button a dead button.

- [#138](https://github.com/TeFuirnever/oh-my-matrix/pull/138) [`3e75cf4`](https://github.com/TeFuirnever/oh-my-matrix/commit/3e75cf4021b006ab7b437d843ddbbca0dbe41593) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot: structured progress ledger, replacing the "Turn N/M completed" counter (E5 / P1-11 + P1-13).

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

- [#143](https://github.com/TeFuirnever/oh-my-matrix/pull/143) [`150478d`](https://github.com/TeFuirnever/oh-my-matrix/commit/150478dba2878a37bced515ca501d429189f36dd) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot: stall detection 双向 fix — inflight tool guard + productivity/no-progress detection (E6 / P0-6 + P1-14).

  **dir-1 — inflight tool guard (fixes false-stall on long tools, P0-6 误报 + P1-14):**

  - New `inFlightToolStartedAt` state field, set when a tool dispatches (`before_tool_call`, allow-path) and during validation (`complete` path). While set, the 60s stall patrol uses a longer per-tool cap (30min, `INFLIGHT_TOOL_CAP_MS`) instead of `stallTimeoutMs`, so a legitimately long build/test no longer false-stalls at 300s. A genuinely hung tool still trips at the cap.
  - Cleared on `after_tool_call`, `agent_end`, and `before_agent_finalize` so a dangling field (the model finalized mid-tool, or a crash) can't permanently relax stall detection.

  **dir-2 — productivity/no-progress detection (fixes missed spin, P0-6 漏报):**

  - New `no_progress` PauseReason/BlockedReason (resumable, like `stalled`). When a run takes N consecutive turns with zero files-touched/commands-run (configurable via `no_progress_turns`, default 3), the patrol pauses it — catching read-only loops and A→B→A→B churn that pure-silence detection misses.
  - The signal is exec-class-filtered ledger activity (E5's ledger already records only write/exec tools, never read-only) — a pure-analysis run records nothing, so no_progress can fire. Fail-open: no ledger / 0 threshold → skip.

  Known: `no_progress` is also added to `RESUMABLE_BLOCKED_REASONS` (recoverable via a user resume/nudge, like `stalled`).

- [#144](https://github.com/TeFuirnever/oh-my-matrix/pull/144) [`a64caf6`](https://github.com/TeFuirnever/oh-my-matrix/commit/a64caf651233bd611216809ada10695d5cbe83fb) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Autopilot: mid-run evidence gate — run validation every N turns, not just on `complete` (E7 / P0-4 放大因素).

  - The revise path now runs the configured validation commands every N turns (`midrun_validation_interval`, default 5; 0 disables), turning "find out it's all wrong at the very end" into early correction.
  - Reuses the existing `runValidationCommands` + `evaluateEvidence` — no new execution path.
  - A mid-run failure does **not block** (still `revise`); the failed commands' stderr is appended to the revise instruction so the model fixes before continuing.
  - Throttled by **turn count** (`totalContinuations % N === 0`), not time — validation is slow, time-based throttling would compound on slow commands.
  - Marks `inFlightToolStartedAt` during the mid-run run so the E6 stall patrol's inflight guard covers it (no false-stall, no TOCTOU with the evidence gate).

  N≥5 recommended: smaller N collides with the E2 wall-clock cap (validation adds latency each cycle). Only fires when validation commands are configured AND the workspace is trusted (the existing trust boundary applies).

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
