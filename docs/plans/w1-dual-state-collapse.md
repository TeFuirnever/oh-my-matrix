# Plan — W1: Dual State Machine Collapse (Autopilot status sole-writer)

> **Risk:** HIGH — core state machine, public npm contract, 704 test blocks.
> **Mode:** DELIBERATE (pre-mortem + expanded test plan).
> **Source finding:** `docs/audits/autopilot-correctness-review-2026-07-04.md` W1 + HIGH.
> **Prereq satisfied:** H1 (evidence-gate false-completion) already patched in #75. W1 is the root-cause structural fix.

---

## 0. Problem, precisely

`AutopilotState.status` is mutated by **three independent mechanisms** that can disagree. The H1 bug was a direct symptom: the reducer moved `orchestrationState → 'retry_queued'` on evidence failure but left `status='running'`; `index.ts` then branched on `status` and mis-routed into `complete()`, producing a false `'done'`. `orchestrator.ts:4` claims a single-writer contract that is **false**.

The goal: make `status` a consequence of `orchestrationState` (and a small set of flags), written by exactly one path — the orchestrator reducer — so two machines can never again disagree.

---

## 1. Mutation-site inventory (grounded, file:line)

Every site below currently writes `status` (directly or via a throw-setter). These are the contract for Phase 2.

### 1a. Mechanism 1 — throw-setters (`src/autopilot-state.ts`)

| Setter | Line | Sets `status` to | Also manages | Called from (index.ts) |
|---|---|---|---|---|
| `activate()` | `autopilot-state.ts:5-10` | `'running'` | `enabled:true` | `1052`, `1074` |
| `deactivate()` | `:12-24` | `'idle'` | `enabled:false`, clears `pauseReason`/`needsCrossTurnResume`/`degraded` | `1130` |
| `pause()` | `:26-31` | `'paused'` | `enabled:false`, `pauseReason`, `needsCrossTurnResume:false` | `445`, `505`, `845`, `891` |
| `complete()` | `:33-38` | `'done'` | `enabled:false`, clears NCTR/degraded | `512` |
| `resume()` | `:40-54` | `'running'` | `enabled:true`, clears `pauseReason`/`toolErrorCount`/NCTR/degraded | `1108` |

### 1b. Mechanism 2 — reducer explicit writes (`src/orchestrator.ts`)

| Event | Line | Sets `status` | Gap |
|---|---|---|---|
| `activate_requested` | `orchestrator.ts:47` | `'running'` | — |
| `evidence_finished` (passed/skipped) | `:204` | `'done'` | — |
| **every other branch** | — | *(inherited via `...state` — NOT derived)* | **the H1 site: branches that move orchState but never reconcile status** |

### 1c. Mechanism 3 — `index.ts` direct spreads / setter dispatch

| Line | Code (essence) | Status outcome | Notes |
|---|---|---|---|
| `index.ts:207` | `{ ...base, status:'running', ... }` | running | **test helper** (`_triggerRetryCheckForTest`), prod-guarded |
| `index.ts:925` | `{ status:'idle', ... }` | idle | **projection fallback** for unknown session (no run) — not a real run mutation; see §1d |
| `index.ts:445` | `pause(state, decision.pauseReason)` | paused | `decideContinuation` 'pause' branch |
| `index.ts:505` | `pause({...updated, evidence}, 'validation_failed')` | paused | evidence failed + reducer blocked path |
| `index.ts:512` | `complete({...updated, evidence})` | done | evidence passed fallback (H1 guard site) |
| `index.ts:845` | `pause(updated, 'max_total_reached')` | paused | agent_end degraded @ max |
| `index.ts:867-873` | `{...current, needsCrossTurnResume:true, ...}` | *(inherited running)* | degraded-fallback cross-turn — **writes NCTR without status/orchState change** (open Q in snapshot) |
| `index.ts:885` | `{...updated, needsCrossTurnResume:true}` | *(inherited)* | degraded canary-miss |
| `index.ts:891` | `isBreaker ? pause(state,'loop_breaker_triggered') : state` | paused-or-inherited | then fed into reducer `agent_turn_finished` |
| `index.ts:1052` | `activate(createInitialState(...))` | running | re-activate (stuck recovery) |
| `index.ts:1074` | `activate(createInitialState(...))` | running | fresh activate |
| `index.ts:1108` | `resume(orchestrated)` | running | gateway `autopilot.resume` |
| `index.ts:1130` | `deactivate(orchestrated)` | idle | gateway `autopilot.stop` |

### 1d. Two "fake" mutation sites — excluded from Phase 2

- `index.ts:925` — the **session-extension projection fallback** for a session with no autopilot run. It emits a synthetic `idle` projection object, not a run-state mutation. **Do not route through the reducer** (there is no run). Leave as-is; it already agrees with derivation (no run ⇒ idle).
- `index.ts:207` — `_triggerRetryCheckForTest`, behind `NODE_ENV !== 'production'`. It will adopt the derived status in Phase 1 (use `deriveStatus`), but it is not a production writer.

**Net production writers to collapse: 9 setter dispatches + 2 reducer writes that must become the *only* writers + 3 NCTR-only spreads that incidentally preserve a stale status (867, 873, 885).**

### 1e. Reducer-event gaps (why this isn't "just route through existing events")

The reducer does **not** currently model every status transition the setters express:

| Setter semantic | Reducer event today? | Verdict |
|---|---|---|
| pause (4 call sites, 4 reasons) | ❌ none | **Needs a new `pause_requested` event** (or the reducer absorbing `pause()`) |
| deactivate→idle (stop) | ⚠️ `stop_requested` exists but sets orchState=`blocked`, not idle | **Needs reconciliation** — see §3 decision |
| complete→done | ✅ `evidence_finished` passed | OK |
| resume→running | ✅ `resume_requested` (sets `claimed`+NCTR) | OK; handler composes with `resume()` |
| activate→running | ✅ `activate_requested` | OK |

This gap is the reason the plan has a Phase 1.5 (reducer completeness) — it cannot be skipped.

---

## 2. The derivation mapping (target)

`deriveStatus(state): AutopilotStatus` — the single pure function that, given any `AutopilotState`, returns the canonical status. This is the contract every phase protects.

```
orchestrationState === 'done'                                          → 'done'
orchestrationState === 'blocked' && reason ∈ RESUMABLE_BLOCKED_REASONS → 'paused'   // user-resumable
orchestrationState === 'blocked' && reason === 'user_stopped'          → 'idle'     // explicit deactivate/stop only
orchestrationState === 'blocked' (any other reason)                    → 'paused'   // parked run (terminal-pause or reducer-error); non-resumable but NOT idle
orchestrationState ∈ {unclaimed,claimed,running,released,retry_queued} → 'running'
orchestrationState === undefined (no run / pre-activate)               → 'idle'
```

> **Refinement (forced by behavior preservation, Principle #5 + TENSION 3):** an earlier draft mapped all terminal-`blocked` → `'idle'`. That is too coarse: `pause('loop_breaker_triggered')` and `pause('max_total_reached')` yield `'paused'` today (`autopilot-state.ts:30`), and normalizing them to `'idle'` would be a silent status change the golden master would flag. The only blocked state that derives `'idle'` is `user_stopped` (the `deactivate()`/`stop_requested` path). Every other blocked reason — terminal-pause (`loop_breaker_triggered`, `max_total_reached`, …) or reducer-error (`workspace_create_failed`, `max_retries_reached`, …) — derives `'paused'`: the run is *parked*, not cleared. The resumable *subset* is still governed by `RESUMABLE_BLOCKED_REASONS` (a non-resumable `'paused'` run shows no working "Resume"; `resume_requested` no-ops). The Phase-1 cross-product test pins every cell.

Notes / hazards surfaced during grounding:

1. **`blocked` is overloaded.** Today it can mean *recoverable-paused* (validation_failed, stalled, evidence_missing) or *terminal* (permission_denied, user_stopped, max_retries_reached). `pause()` is called for some, `deactivate()` for others. The mapping above splits on `RESUMABLE_BLOCKED_REASONS` (`orchestrator.ts:19-23`). **This split must be validated by the Phase-1 invariant tests** before any writer changes — it is the riskiest assumption in the derivation.

   **⚠️ TENSION 1 (lossy mapping — must be fixed in Phase 1, before Phase 1.5):** The Phase-1.5 `pause_requested` reducer branch reuses `toBlockedReason(reason: PauseReason)` (`types.ts:59`) to coerce a `PauseReason` → `BlockedReason`. **`toBlockedReason` falls back to `'validation_failed'` for 6 of the 10 `PauseReason`s** (any value not in `VALID_BLOCKED_REASONS`). Since `'validation_failed' ∈ RESUMABLE_BLOCKED_REASONS`, those 6 terminal pauses would silently become **resumable** — a production hazard (host shows a "Resume" button for a run that hit `max_attempts_reached` / `loop_breaker_triggered` / `context_overflow_unrecoverable` etc.; `resume_requested` no-ops, run looks stuck). This must NOT be left to the silent fallback.

   **Explicit PauseReason → BlockedReason mapping table (the contract `deriveStatus` relies on):**

   | # | `PauseReason` | → `BlockedReason` | resumable? | terminal? | Rationale |
   |---|---|---|---|---|---|
   | 1 | `permission_denied` | `permission_denied` | ✗ | ✓ | direct match; already non-resumable |
   | 2 | `user_stopped` | `user_stopped` | ✗ | ✓ | direct match; already non-resumable |
   | 3 | `token_budget_exceeded` | `token_budget_exceeded` | ✗ | ✓ | direct match; already non-resumable |
   | 4 | `validation_failed` | `validation_failed` | ✓ | — | direct match; resumable (retryable) |
   | 5 | `max_attempts_reached` | **`max_retries_reached`** | ✗ | ✓ | per-turn attempts exhausted → bucket with reducer's own `max_retries_reached` |
   | 6 | `max_total_reached` | **`max_total_reached`** *(NEW BlockedReason)* | ✗ | ✓ | total-continuation cap; not retryable. Add to `VALID_BLOCKED_REASONS` + deriveStatus non-resumable set |
   | 7 | `tool_error_repeated` | **`tool_error_repeated`** *(NEW BlockedReason)* | ✗ | ✓ | threshold crossed; the model is failing repeatedly. Add to `VALID_BLOCKED_REASONS` |
   | 8 | `loop_breaker_triggered` | **`loop_breaker_triggered`** *(NEW BlockedReason)* | ✗ | ✓ | circuit tripped; terminal until manual intervention. Add to `VALID_BLOCKED_REASONS` |
   | 9 | `context_overflow_unrecoverable` | **`context_overflow_unrecoverable`** *(NEW BlockedReason)* | ✗ | ✓ | unrecoverable by name. Add to `VALID_BLOCKED_REASONS` |
   | 10 | `injection_rejected` | **`injection_rejected`** *(NEW BlockedReason)* | ✓ *(resumable)* | — | the cross-turn injection was refused; the run can be resumed manually. Add to `VALID_BLOCKED_REASONS` + add to resumable set |

   **Net change to types:** add 5 new `BlockedReason` values (`max_total_reached`, `tool_error_repeated`, `loop_breaker_triggered`, `context_overflow_unrecoverable`, `injection_rejected`), each to `VALID_BLOCKED_REASONS`. Map row 5 (`max_attempts_reached`) to the existing `max_retries_reached` (no new value). This **eliminates the silent fallback** — every `PauseReason` has an explicit, intentional `BlockedReason`. Replace `toBlockedReason` usage in the `pause_requested` branch with a dedicated, total `pauseReasonToBlockedReason` map (no fallback parameter) so a future unhandled `PauseReason` is a *type error*, not a silent `'validation_failed'`.

   **Re-derive `RESUMABLE_BLOCKED_REASONS` explicitly (do NOT inherit it as stable):** after the mapping, the resumable set is `{'stalled', 'validation_failed', 'evidence_missing', 'injection_rejected'}`. Today it is `{'stalled', 'validation_failed', 'evidence_missing'}` (`orchestrator.ts:19-23`). The single addition (`injection_rejected`) is a deliberate, documented widening — a run whose cross-turn injection was refused is genuinely resumable by the user. Record this in the ADR. **Do not treat the existing set as a frozen truth**: the Phase-1 cross-product test (below) is what proves the new set is consistent.
2. **`idle` vs `paused` for blocked states.** A blocked run is `'idle'` only for `user_stopped` (the explicit deactivate/`stop_requested` path). Every other blocked reason is `'paused'` (parked) — this preserves today's `pause()` → `'paused'` for terminal pauses like `loop_breaker_triggered` and today's reducer-error blocked states, avoiding a silent status change. The snapshot's loose "done or paused, varies" is sharpened here; the resumable subset is still governed by `RESUMABLE_BLOCKED_REASONS` (see note 1).
3. **`enabled` is coupled** to status (`running`⇒true, else false, roughly). The derivation does NOT own `enabled`; the reducer continues to set it. But every Phase-2 change must preserve `enabled` parity with today.
4. **`needsCrossTurnResume` (W2) is out of scope** for this plan. The 3 NCTR-only spreads (867/873/885) are touched only to stop them from accidentally clobbering a *derived* status; their NCTR semantics are deferred to W2.

---

## 3. RALPLAN-DR (deliberate)

### Principles
1. **Single-writer with machine-checked invariant and CI lint gate.** After every reducer step, `(status, orchState)` agrees with the derivation function. The invariant is asserted by a test (Phase 1+) and reinforced by a CI lint rule banning `status:` literals outside the reducer (Phase 3). It is *not* structurally impossible to violate — a stray spread can still write the field — but the lint gate + invariant test catch it. (This is the honest framing; the ADR makes the "status-only" scope of sole-writership explicit — `resume()` remains a writer of 5 other coupled fields, see §3 Option B.)
2. **Each phase is independently green and revertable** — every phase ends with all 704 tests passing and a shippable artifact. A revert is a single `git revert`.
3. **The projection contract is frozen at the index.ts/projection boundary (post-setter-override), NOT the reducer boundary.** `AutopilotProjection.status` (and `canStop`, `modelTier`, `thinkingIntensity` which branch on it) must be bit-identical for every reachable state, pre- and post-refactor. The golden-master characterization suite is captured at the boundary hosts actually observe: the `projectState()` call in the session-extension projection (`index.ts:920-937`) and the `setState`-then-read point — i.e. *after* the setter dispatch has applied, not at the reducer's intermediate return. This is the public npm boundary.
4. **Validate the mapping before trusting it.** The derivation function is proven correct (Phase 1) *before* it becomes the writer (Phase 2). Never move trust and introduction into the same phase.
5. **No silent semantics change.** Where today's behavior is inconsistent (e.g. terminal-blocked sometimes idle, sometimes done), we pick the dominant existing behavior and record it in the ADR — we do not "fix" it inside this refactor.

### Decision Drivers (top 3)
1. **The 704-test safety net** — the highest-leverage guard we have. Phases are sized so each is covered by a determinable subset; if a phase breaks tests outside its subset, that's a signal to stop.
2. **Projection / public contract stability** — `projection.ts:73,86,110` and the session-extension projection (`index.ts:920-937`) are consumed by hosts. Any status-timing change ripples to `modelTier`/`thinkingIntensity` resolution at runtime.
3. **H1-class bug prevention** — the whole point. The chosen design must make the H1 divergence a *machine-checked invariant* (test asserts `status === deriveStatus(state)` after every reducer step) reinforced by a *CI lint gate* (no `status:` literals outside the reducer), not merely patched.

### Viable Options

#### Option A — Derive-on-read via a getter on the state object ❌
Make `status` a JS getter computed from `orchState`/flags.
- **Pros:** truly unrepresentable-illegal; zero writer sites to chase.
- **Cons:** `AutopilotState` is a plain `{}` spread ~30× across the codebase (`{...state, ...}`); instance getters do **not** survive `Object.assign`/spread, so every spread would silently drop the getter and re-stale the field. Migrating to a class/factory breaks 704 tests' `{status:'running'}` literal construction. **Rejected — blast radius dwarfs the benefit.**

#### Option B — Stored field, reducer as sole writer of `status`, status derived inside the reducer ✅ (CHOSEN)
Keep `status` as a stored field (no type/test churn), but make the reducer the only writer of the **`status` field** and have **every** reducer branch end by computing `status = deriveStatus(next)`. Delete/demote the throw-setters.
- **Pros:** spreads keep working unchanged; tests that read `state.status` keep working; the reducer's single-writer claim becomes *true*; derivation is a pure function unit-testable in isolation.
- **Cons:** the field can still be written by a stray spread — enforced by lint/test, not the type system. Requires reducer-completeness work (new `pause_requested`, reconcile `stop`) before setters can go.
- **Sole-writer is status-only (explicit scope):** the reducer becomes the sole writer of `status`. The 5 other coupled fields (`enabled`, `pauseReason`, `toolErrorCount`, `lastToolError`, `needsCrossTurnResume`, `degraded`) are **not** claimed by this invariant. In particular `resume()` remains a writer of those 5 fields (it clears `pauseReason`/`toolErrorCount`/`lastToolError`/`needsCrossTurnResume`/`degraded` and re-enables); only its `status` write is removed in Phase 2b and re-derived by the reducer. Field-level sole-writership for the non-status fields is deferred (W2 owns `needsCrossTurnResume`; the rest stay as setter/state-mutation concerns).
- **Mitigations:** a Phase-1 invariant test that fails if `state.status !== deriveStatus(state)` after any hook path; a Phase-3 lint rule / code-search gate banning `status:` literals outside `createInitialState` + reducer.

#### Option C — Incremental thin-wrapper (setters dispatch reducer events) ⚠️
Keep the 5 setters as facades that internally call the reducer, so call sites in `index.ts` don't change.
- **Pros:** tiny diff at call sites.
- **Cons:** preserves the dual-writer *illusion* (setters still look like writers); the setters today compose non-status fields (pauseReason, NCTR, toolErrorCount) that the reducer doesn't own, so the facade leaks; and it doesn't remove the "two machines can disagree" hazard — it just hides it. **Rejected as the end state**, but **adopted as a transient Phase-2.5 step** to de-risk call-site migration.

### TENSION 3 — Loop-breaker (Phase 2f) reconciliation — pre-decided semantics + state diagram

**The hazard.** Today `index.ts:891` does `pause(state,'loop_breaker_triggered')` *then* feeds the result into `orchestratorReducer(agent_turn_finished)`. The pause sets `status='paused'` but **not** `orchestrationState` (stays `'running'`), so the reducer's `agent_turn_finished` guard (`orchestrationState !== 'running'` → no-op) passes and the turn is accounted. The Phase-2 plan **inverts** this: reducer `agent_turn_finished` first, then `pause_requested`. But post-error the reducer may move to `blocked` (unrecoverable / max retries) or `retry_queued` (recoverable), and then `pause_requested` arrives at a **non-running-family** `orchestrationState`. Which decision wins — the pause, or the reducer's retry/blocked accounting — is **unspecified**. This subsection pre-decides it.

**Pre-decided reconciliation: `agent_turn_finished` wins the retry/accounting; `pause_requested` wins the status only if it is *terminal-to-stronger*.** Concretely:

- The loop-breaker error is, by definition, an error condition the reducer already classifies via `classifyRecoverability` / `shouldRetry` inside `agent_turn_finished`. **The reducer's outcome (retry_queued vs blocked + blockedReason + retry.attempt) is the authoritative retry/accounting** — `pause_requested` must NOT override `retry.attempt`, `orchestrationState`, or `blockedReason` that the error path already set.
- `pause_requested` therefore only applies **when the reducer left the run in a running-family state** (i.e. the reducer no-op'd because orchState was already off `running`, OR the breaker fired on a `success` turn where no error path ran). When `agent_turn_finished` already moved to `blocked`/`retry_queued`, `pause_requested` is a **no-op** (the state is already terminal/queued) — except it must still record the *loop-breaker* `blockedReason` preference if the reducer's blockedReason is generic.

**Intended final state (the contract Phase 2f's test pins):**

```
                  agent_end (success=false, error contains "circuit breaker")
                  on orchState='running'
                                    │
                                    ▼
              ┌─────────────────────────────────────────────┐
              │ 1. reducer(agent_turn_finished, error)       │   ← runs FIRST, owns retry accounting
              │    classifyRecoverability(error)             │
              │    ┌─ recoverable & under maxRetries:        │
              │    │     orchState='retry_queued'            │
              │    │     retry.attempt = N+1                 │
              │    │     (blockedReason unset)               │
              │    └─ unrecoverable OR maxRetries reached:   │
              │          orchState='blocked'                 │
              │          blockedReason = max_retries_reached │
              │          (or classify's non-rec bucket)      │
              └─────────────────────────────────────────────┘
                                    │
                                    ▼
              ┌─────────────────────────────────────────────┐
              │ 2. reducer(pause_requested, 'loop_breaker')  │   ← runs SECOND; status-only reconciliation
              │    IF orchState ∈ running-family:            │
              │       orchState='blocked'                    │
              │       blockedReason='loop_breaker_triggered' │
              │       retry UNCHANGED (still N or unset)     │
              │    ELSE (already retry_queued / blocked):    │
              │       NO-OP on orchState + retry             │
              │       (optionally stamp blockedReason to      │
              │        'loop_breaker_triggered' if it was a  │
              │        generic 'max_retries_reached' — see   │
              │        ADR decision)                         │
              └─────────────────────────────────────────────┘
                                    │
                                    ▼
   FINAL (status, orchState, retry.attempt) — per branch:

   branch A (recoverable breaker, under retry cap):
     status      = deriveStatus → 'running'      (retry_queued is running-family)
     orchState   = 'retry_queued'
     retry.attempt = N+1
     → stall interval will fire retry_due → claimed → re-run. NOT paused.
       (loop-breaker is treated as a transient recoverable error, same as a timeout)

   branch B (breaker + maxRetries reached, OR unrecoverable classification):
     status      = deriveStatus → 'paused'      (blocked + loop_breaker_triggered ∉ resumable)
     orchState   = 'blocked'
     blockedReason = 'loop_breaker_triggered'    (stamped by pause_requested, overrides generic max_retries)
     retry.attempt = N (unchanged; do not bump)
     → terminal pause; resume_requested no-ops (loop_breaker_triggered ∉ RESUMABLE_BLOCKED_REASONS)
```

**Why this is safe + behavior-preserving for the common case:** today, a loop-breaker on a recoverable turn calls `pause()` → `status='paused'` (but orchState stays `running`, so retry accounting is *never run* — the breaker pause pre-empts the reducer). The host sees `paused` and the run sits there until manual resume. Under the new semantics, a recoverable loop-breaker is **retried automatically** (`retry_queued` → `running`) rather than paused — which is *more correct* (it matches how a plain recoverable error is treated) and matches `classifyRecoverability`'s existing judgment that a circuit-breaker-style error is recoverable. **If we want to preserve today's "always pause on breaker" behavior exactly**, the alternative is: `pause_requested` always wins (overrides retry_queued → blocked + loop_breaker). This is a real product decision — **flagged for the Critic; default chosen = "reducer wins retry accounting" (branch A/B above) because it is consistent with how every other error is handled.**

### Pre-mortem — 3 ways the chosen approach (B) fails

1. **Derivation mis-classifies terminal `blocked` vs recoverable `blocked`.**
   *Scenario:* Phase 2 routes `pause()` sites through `pause_requested`. A terminal pause (e.g. `max_total_reached`, `loop_breaker_triggered`) gets its `BlockedReason` mis-mapped to something in `RESUMABLE_BLOCKED_REASONS` → derives `'paused'`-resumable. The host UI shows a "Resume" button for an unrecoverable run; user clicks it; `resume_requested` no-ops but projection still says `paused` → stuck, unresumable, looks broken.
   *Catch:* **this is TENSION 1** — the explicit `PauseReason → BlockedReason` table (§2 note 1) + the total `pauseReasonToBlockedReason` (no fallback) eliminate the lossy path; the Phase-1 `pause-reason-mapping.test.ts` pins all 10 rows (resumable flag included) and goes red on `main` for the 6 lossy cases before any writer change. The `projection-pause-reasons.e2e.test.ts` is the e2e regression guard.

2. **A mutation site's side-effect ordering breaks when composed through the reducer (loop-breaker, Phase 2f).**
   *Scenario:* `index.ts:891` today does `pause(state,'loop_breaker_triggered')` *then* feeds the result into `orchestratorReducer(agent_turn_finished)`. If Phase 2 inverts the order (reducer first, then `pause_requested`), post-error the reducer may move to `blocked`/`retry_queued`, and then `pause_requested` arrives at a non-running-family orchState — which decision wins (pause vs retry-accounting) was **unspecified**.
   *Resolution (this was the hazard; it is now pre-decided — see §"TENSION 3" above):* `agent_turn_finished` owns retry/accounting; `pause_requested` is status-only and no-ops when the reducer already moved off running-family. The state diagram + branch-A/branch-B final `(status, orchState, retry.attempt)` table is the contract.
   *Catch:* the Phase-2f loop-breaker e2e pins **both** branches: (A) recoverable breaker under retry cap → `retry_queued`/`running`/`attempt+1`; (B) breaker at max retries → `blocked`/`paused`/`loop_breaker_triggered`/`attempt` unchanged. Assert final `(status, orchState, blockedReason, retry.attempt)`. `orchestrator-integration.test.ts` + the new loop-breaker test are the guards.

3. **(Revised — honest TOCTOU, OUT OF SCOPE for W1.) Pre-existing race on the `maxConcurrent` guard, unrelated to status derivation.**
   *Scenario:* two concurrent `autopilot.activate` calls both pass the concurrency guard at `index.ts:974-978` (each reads `runningCount` *before* either has `setState`'d the new running status), so both proceed and `maxConcurrent` is exceeded by one.
   *Honest acknowledgment:* an earlier draft of this plan attributed this to "status derivation shifts timing, a reader sees a one-tick stale value." **That scenario is unreachable.** The reducer runs synchronously inside the same call frame as `setState` (`index.ts` is JS single-threaded; reducer→setState is a straight-line sequence with no await between them), so there is no window where a *single* activate observes a stale `status`. The real hazard is the **TOCTOU across two concurrent activate calls** — a pre-existing bug independent of W1: it exists on `main` today and W1 neither introduces nor fixes it (derivation does not change *when* the running status becomes visible relative to the guard, because the guard reads the *other* sessions' states, not the in-flight one).
   *Catch:* **out of scope.** File as a separate item (W-x / hardening). Do not expand W1 to fix it. The W1 concurrency test (`autopilot-concurrency.test.ts`) remains the regression guard for the *boundary value* (status count at exactly `maxConcurrent`), which is what W1 must not disturb.

### Expanded test plan

**Unit (derivation mapping) — Phase 1, lands first:**
- New `tests/derive-status.test.ts`: table-driven over the full cross-product of `orchestrationState` × `blockedReason` × `{enabled, hasRun}`. Pins every cell of the §2 mapping. This is the spec for `deriveStatus`.
- Add to `tests/orchestrator.test.ts`: after *every* event, assert `result.status === deriveStatus(result)`. Turns the "single-writer" claim into a machine-checked invariant.
- **TENSION 1 cross-product test (Phase 1, goes RED before any writer change):** add `tests/pause-reason-mapping.test.ts` — for **each of the 10 `PauseReason`s**, assert the resulting `blockedReason` (via the explicit map from §2 note 1) **and** the derived `status` (via `deriveStatus`) **and** the derived `resumable` flag (membership in the re-derived `RESUMABLE_BLOCKED_REASONS`). This test encodes the mapping table as code. **Before** the Phase-1.5 `pause_requested` branch + new `BlockedReason` values are added, the 6 lossy rows (`max_attempts_reached`, `max_total_reached`, `tool_error_repeated`, `loop_breaker_triggered`, `context_overflow_unrecoverable`, `injection_rejected`) **fail** because the current `toBlockedReason` collapses them all to `'validation_failed'` (resumable) — proving the hazard exists on `main`. After Phase 1.5 lands the explicit map + new `BlockedReason` values, all 10 go green. This is the red→green proof the mapping is fixed, not inherited.

**Integration (each phase's invariant) — Phase 2, per site:**
- For each of the 9 setter-dispatch sites + 3 NCTR spreads: a test that drives the same hook path as today and asserts the **identical** post-state `(status, orchState, enabled, pauseReason)` as on `main`. This is a characterization suite (golden master) frozen before Phase 2 begins. **Boundary caveat (Phase boundary):** the golden master is captured at the **index.ts/projection boundary** — i.e. read the state *after* the setter dispatch / `setState` has applied (the value `projectState()` and downstream consumers observe), NOT at the reducer's intermediate return. The reducer's intermediate state is an implementation detail; hosts never see it. Concretely: the characterization reads `projectState(setState-applied-state)` (the session-extension projection at `index.ts:920-937`) and/or the post-`setState` map entry — matching exactly what `main` produces at that same boundary.
- New `(status, orchState) ∈ legalPairs` invariant test (the W4 gap from the audit) — run across the full `orchestratorReducer` event matrix.

**E2E (full lifecycle) — Phase 2 exit gate:**
- Extend `tests/e2e/lifecycle.e2e.test.ts` and `evidence-gate-execfile.e2e.test.ts` to cover the complete cycle: `activate → run → evidence(pass) → done` AND `activate → run → evidence(fail) → retry → block → pause` AND `pause → resume → run → done`. Assert `projection.status` at every beat. The H1 guard at `evidence-wiring.test.ts:198-204` (`status==='running'` after failed evidence) is the must-not-regress assertion.
- New loop-breaker e2e (TENSION 3 / pre-mortem #2): agent ends with circuit-breaker error — pin **both** branches from the §TENSION-3 diagram: (A) recoverable + under retry cap → `retry_queued`/`running`/`attempt+1` (auto-retried, not paused); (B) breaker at maxRetries → `blocked`/`paused`/`blockedReason='loop_breaker_triggered'`/`attempt` unchanged. Assert final `(status, orchState, blockedReason, retry.attempt)`.

**Observability (projection contract unchanged) — every phase:**
- `tests/projection.test.ts` + `m2-types-projection.test.ts`: snapshot/assert that for a fixed `AutopilotState`, `projectState()` output is byte-identical pre/post. Specifically `canStop`, `modelTier`, `thinkingIntensity` (the three status-branching fields).
- Add one assertion: `projectState(deriveStatus-equivalent state).status === deriveStatus(state)` for a representative sample — proves the projection reads the same field the derivation defines.

---

## 4. Phased implementation plan

Each phase: independently testable, independently revertable, ends green.

### Phase 1 — Introduce + prove `deriveStatus`; pin the lossy-mapping hazard (no writer changes) 🟢 low risk
**Goal:** the mapping is correct and machine-checked, and the Tension-1 lossy-mapping hazard is *demonstrated red* before any writer changes.

1. Add `export function deriveStatus(state: AutopilotState): AutopilotStatus` to `src/autopilot-state.ts` (lives next to the setters it will eventually replace; pure, no I/O).
2. Add `tests/derive-status.test.ts` — the full mapping table (§2), every `BlockedReason` (`types.ts:26-36`) × `orchestrationState`.
3. Add an **invariant assertion** to `tests/orchestrator.test.ts`: after every reducer event, `expect(result.status).toBe(deriveStatus(result))`. **Expect this to FAIL today** on the branches the reducer doesn't touch (the H1 residue: `agent_turn_finished` error→retry_queued leaves status stale). → These failures are the precise Phase-2 worklist. Commit them as `.skip` with a TODO, or land Phase 1 with the assertion scoped to currently-consistent branches — either way, document the gap.
4. **TENSION 1 — add `tests/pause-reason-mapping.test.ts`:** the `PauseReason × pause_requested` cross-product test (10 rows). For each `PauseReason`, assert the *intended* `blockedReason` (the explicit table in §2 note 1), the derived `status`, and the `resumable` flag. **This test goes RED on the 6 lossy rows on `main`** (the current `toBlockedReason` returns `'validation_failed'` for them), proving the hazard *before* Phase 1.5 fixes it. Land it red (with a documented expectation that Phase 1.5 greens it), OR land it `.skip`'d on the 6 rows with a TODO — either way the hazard is captured in CI, not buried in prose.
5. **No changes to `index.ts`, no changes to setters, no changes to projection.** No new `BlockedReason` values yet (that's Phase 1.5 — Phase 1 only *specifies* the intended map via the test).

**Verify:** new tests pass where the current code is correct (derive-status table, invariant on consistent branches); the pause-reason-mapping test is present and its red/skip status is explicit; `pnpm test` green; typecheck green.
**Revert:** delete the function + 3 test files.

### Phase 1.5 — Make the reducer complete (close the event gaps) 🟡 medium risk
**Goal:** the reducer can express every status transition the setters can, so Phase 2 has somewhere to route to.

1. Add `pause_requested` event to `OrchestratorEvent` (`types.ts:180-193`): `{ type:'pause_requested'; runId; reason: PauseReason; now }`. Reducer branch:
   - **running-family orchState** (`unclaimed/claimed/running/released`) → `blocked` + `blockedReason = pauseReasonToBlockedReason(reason)`, `enabled:false`, end with `status: deriveStatus(next)`.
   - **non-running-family orchState** (`blocked`/`retry_queued`/`done`) → **no-op on orchState, retry, enabled**; only stamp `blockedReason` if currently unset/generic (this is the TENSION-3 reconciliation seam for the composed loop-breaker case in 2f, where `agent_turn_finished` already ran). End with `status: deriveStatus(next)`.
   - **TENSION 1 — do NOT reuse `toBlockedReason`.** Add the 5 new `BlockedReason` values to `types.ts` (`max_total_reached`, `tool_error_repeated`, `loop_breaker_triggered`, `context_overflow_unrecoverable`, `injection_rejected`) and to `VALID_BLOCKED_REASONS`, and implement a **total** `pauseReasonToBlockedReason(reason: PauseReason): BlockedReason` (an exhaustive switch / record with **no fallback parameter** — an unhandled `PauseReason` is a compile error, not a silent `'validation_failed'`). Use the explicit table in §2 note 1. Re-derive `RESUMABLE_BLOCKED_REASONS` = `{'stalled','validation_failed','evidence_missing','injection_rejected'}` (the `injection_rejected` addition is the one deliberate widening — see ADR).
   - **This is what greens the Phase-1 `pause-reason-mapping.test.ts`.** All 10 rows now pass with the intended terminal/resumable classification.
2. Reconcile `stop_requested`: decide (ADR §Decision) whether terminal stop ⇒ `idle` (today's `deactivate`) by adding a terminal flag or a `deactivate_requested` event. **Recommended:** keep `stop_requested` → `blocked`+`user_stopped` (existing), and add an explicit `deactivated` terminal where `deriveStatus` returns `idle`. The `autopilot.stop` handler dispatches both (stop_requested then deactivate) as it does today — but both through the reducer.
3. **Every existing reducer branch** gets a final `status: deriveStatus(next)` line (replace the 2 hardcoded `status:` writes at `:47` and `:204` with the derived call; add it to all other branches). This is the moment the reducer becomes internally consistent.
4. The setters still exist and still win at the call sites — but the invariant test from Phase 1 now passes for the reducer in isolation.

**Verify:** `orchestrator.test.ts` invariant assertion now passes for ALL events; `evidence-wiring` H1 guard still green (reducer alone produces correct status); no `index.ts` behavior change yet (setters still override).
**Revert:** remove the new event + the `deriveStatus` calls in the reducer.

### Phase 2 — Route the 9 setter sites + 3 spreads through the reducer 🔴 highest risk
**Goal:** the reducer is the sole production writer. Setters still exist but are no longer called.

Migrate **one call site at a time**, each behind its own commit + its characterization test:

| Order | Site | Change | Paired test |
|---|---|---|---|
| 2a | `index.ts:1052,1074` (activate) | drop `activate()`; reducer `activate_requested` already sets running+enabled | `autopilot-activate-idempotent.test.ts` |
| 2b | `index.ts:1108` (resume) | drop `resume()`; reducer `resume_requested` + a new reducer step for the toolErrorCount/pauseReason clear (or keep `resume()` as a thin field-clearer that does NOT touch status) | `orchestrator-integration.test.ts` |
| 2c | `index.ts:1130` (stop/deactivate) | route through `stop_requested` + deactivate semantics in reducer | `autopilot-stop-meta-cleanup.test.ts` |
| 2d | `index.ts:445` (pause, decideContinuation) | dispatch `pause_requested` | new characterize test |
| 2e | `index.ts:845` (pause, max_total) | dispatch `pause_requested` | `production-hardening.test.ts` |
| 2f | `index.ts:891` (pause, loop_breaker) then `agent_turn_finished` | **ordering + reconciliation** — per §TENSION 3: dispatch `agent_turn_finished` first (owns retry accounting), then `pause_requested` (status-only; no-op when reducer already moved off running-family). The `loop_breaker_triggered` `blockedReason` is stamped only in branch B (terminal). **This is the single riskiest commit in the plan** (see §6). | new loop-breaker e2e (both branches A & B) |
| 2g | `index.ts:505,512` (evidence branch) | drop `pause()`/`complete()`; trust reducer output; the H1 three-way (`index.ts:499-512`) simplifies to `setState(runId, updated)`. **Well-guarded** — the reducer already produces the correct status post-Phase-1.5, and `evidence-wiring.test.ts:198-204` is a direct, high-signal regression guard for the exact H1 failure. Lower risk than 2f. | `evidence-wiring.test.ts` (the H1 guard) |
| 2h | `index.ts:867,873,885` (NCTR spreads) | stop letting them carry an implicit status; they compose onto a reducer-produced state (NCTR itself is W2) | token-double-count / degraded tests |

After 2a–2h: the Phase-1 invariant test is enabled repo-wide (un-skip). Any failure = a writer escaped the reducer.

**Verify:** the golden-master characterization suite (frozen pre-Phase-2, captured at the index.ts/projection boundary — see Phase boundary caveat in §3) matches `main` byte-for-byte on `(status, orchState, enabled, pauseReason)`; full e2e lifecycle green; concurrency boundary test green.
**Revert:** each sub-step is its own commit; revert the offending commit.

### Phase 3 — Demote / delete the throw-setters + lint gate 🟢 low risk
**Goal:** the dual-writer hazard is closed by enforcement (lint + invariant), not by structural impossibility.

1. The 5 setters (`activate/deactivate/pause/complete/resume`) now have zero call sites. Either delete them, or demote to `@deprecated` thin wrappers over the reducer (for any out-of-tree consumers — check npm export surface).
2. Add a lint/search gate (e.g. eslint `no-restricted-syntax` or a CI grep) forbidding `status:` object-literal keys outside `createInitialState` (`types.ts:281`) and `orchestratorReducer` branches.
3. Update `orchestrator.ts:4` comment from aspirational to true.
4. Update `docs/audits/autopilot-correctness-review-2026-07-04.md` W1 → resolved; link ADR.

**Verify:** `pnpm test` + `pnpm typecheck` + `pnpm -r build` green; the lint gate passes.
**Revert:** revert the commit.

---

## 5. ADR skeleton (`docs/adr/016-autopilot-status-sole-writer.md`)

```markdown
# ADR-016: Autopilot `status` is a derived, sole-writer (status-only) field

## Status
Accepted (2026-07-XX).

## Decision
`AutopilotState.status` is a stored field, but the orchestrator reducer
(`src/orchestrator.ts`) is its sole writer **of the `status` field**. Every
reducer branch computes `status` via the pure `deriveStatus(state)` function
(`src/autopilot-state.ts`), which maps `orchestrationState` (+ `blockedReason`
∈ RESUMABLE_BLOCKED_REASONS) to the canonical `AutopilotStatus`. The 5
throw-based setters lose their `status` writes.

**Sole-writer is status-only (explicit scope).** The reducer is the sole
writer of `status`. It is NOT the sole writer of the 5 other coupled fields
(`enabled`, `pauseReason`, `toolErrorCount`, `lastToolError`,
`needsCrossTurnResume`, `degraded`). `resume()` remains a writer of those 5
fields (clears pauseReason/toolErrorCount/lastToolError/NCTR/degraded,
re-enables); only its `status` write is removed. Field-level sole-writership
for non-status fields is deferred (W2 owns NCTR). Do not over-read "sole
writer" as covering the whole state object.

The invariant is enforced by **single-writer + machine-checked invariant + CI
lint gate** — not by making violations structurally impossible. A stray
`{...state, status:'x'}` spread can still desync; it is caught by the Phase-1
invariant test (`status === deriveStatus(state)` after every reducer step)
and the Phase-3 lint rule (no `status:` literals outside the reducer +
`createInitialState`).

## PauseReason → BlockedReason mapping (explicit, no silent fallback)
The reducer's `pause_requested` branch maps `PauseReason` → `BlockedReason`
via a **total** `pauseReasonToBlockedReason` (exhaustive switch, no fallback
parameter — an unhandled PauseReason is a compile error). 5 new BlockedReason
values are added (`max_total_reached`, `tool_error_repeated`,
`loop_breaker_triggered`, `context_overflow_unrecoverable`,
`injection_rejected`) so that no PauseReason collapses to the lossy
`'validation_failed'` fallback. `RESUMABLE_BLOCKED_REASONS` is re-derived =
`{stalled, validation_failed, evidence_missing, injection_rejected}` (the one
addition, `injection_rejected`, is deliberate: a refused cross-turn injection
is user-resumable). See the plan §2 note 1 for the full 10-row table.

## Loop-breaker reconciliation (Phase 2f) — pre-decided
When `agent_end` fires with a circuit-breaker error, the order is:
`agent_turn_finished` first (owns retry accounting: retry_queued vs blocked,
retry.attempt), then `pause_requested` (status-only). `pause_requested` is a
**no-op on orchState/retry** when the reducer already moved off running-family;
it stamps `blockedReason='loop_breaker_triggered'` only in the terminal branch.
Branch A (recoverable breaker under retry cap): final `running`/`retry_queued`/
`attempt+1` — auto-retried, NOT paused (a deliberate, more-correct change from
today's "always pause on breaker"). Branch B (breaker at maxRetries): final
`paused`/`blocked`/`loop_breaker_triggered`/`attempt` unchanged. See plan
§TENSION 3 for the state diagram.

## Drivers
1. H1 (evidence-gate false-completion, #75) was caused by two status writers
   disagreeing; the patch was a branch on `status`, not a fix.
2. The reducer's claimed single-writer contract (`orchestrator.ts:4`) was false.
3. `AutopilotProjection.status` is a public npm contract that must not change.

## Alternatives considered
- **A. Derive-on-read getter:** rejected — `AutopilotState` is a spread plain
  object; getters don't survive `{...state}`, breaking ~30 sites + 704 tests.
- **C. Setters as reducer facades:** rejected as end-state — preserves the
  dual-writer illusion and leaks non-status concerns (pauseReason/NCTR) the
  reducer doesn't own. Used only as a transient Phase-2.5 de-risk.

## Why chosen
Keeps the stored field (no type/test churn), makes the reducer's claim true,
and makes the `(status, orchState)` agreement a machine-checked invariant
(test) reinforced by a lint gate, rather than a convention. Smallest blast
radius for the safety gained.

## Consequences
- Positive: H1-class divergence is a machine-checked invariant + lint gate;
  W1 closed.
- Positive: `index.ts:499-512` (H1 three-way) collapses to `setState(runId, updated)`.
- Positive: the lossy PauseReason→BlockedReason fallback is eliminated
  (TENSION 1); terminal pauses can no longer silently become resumable.
- Negative: `blocked` orchState is overloaded (recoverable vs terminal); the
  split lives in `deriveStatus` + `RESUMABLE_BLOCKED_REASONS` and must be
  maintained when adding a new `BlockedReason`/`PauseReason` (the total
  `pauseReasonToBlockedReason` switch makes a new PauseReason a compile error,
  which is the desired forcing function).
- Negative: loop-breaker branch A is a behavior change (recoverable breakers
  now auto-retry instead of pausing) — flagged for the Critic; default chosen
  for consistency with how every other recoverable error is handled.
- Negative: a stray `{...state, status:'x'}` spread can still desync —
  enforced by a lint gate (Phase 3) + invariant test, not the type system.

## Follow-ups
- W2: collapse `needsCrossTurnResume` (16 write sites) — derive or model as
  explicit orchState. The 3 NCTR spreads touched in Phase 2h are the seam.
- W-x (hardening, OUT OF SCOPE for W1): the pre-existing TOCTOU on the
  `maxConcurrent` guard (`index.ts:974-978`) — two concurrent activates both
  pass the running-count check before either setState's. Independent of W1
  (exists on main today; W1 neither introduces nor fixes it). File separately.
- M2 (audit): wire or delete the und dispatched `workspace_failed` /
  `permission_denied` events now that the reducer is the trusted hub.
- M1: consume `workflow.stallTimeoutMs` in the stall interval (orthogonal).
```

---

## 6. Risk + verification

### Riskiest phase / commit
**Phase 2** (routing call sites). The **single riskiest commit is 2f** (loop-breaker ordering + reconciliation — §TENSION 3): it inverts the pause/reducer order and introduces the "reducer wins retry accounting, pause is status-only" reconciliation, which is a genuine behavior change for recoverable breakers (they auto-retry instead of pausing). 2f gets the dedicated branch-A/branch-B loop-breaker e2e and must be reviewed against the §TENSION-3 state diagram.

**2g (evidence branch, the H1 site) is well-guarded and lower risk:** post-Phase-1.5 the reducer already emits the correct status, so 2g is pure simplification (collapse the `if/else if/else` at `index.ts:499-512` to `setState(runId, updated)`), and `evidence-wiring.test.ts:198-204` is a direct, high-signal guard for the exact H1 failure. Phase 1.5 is medium-risk (adds reducer events + 5 new BlockedReason values), but the setters still override so production behavior is unchanged. Phase 2 is where behavior actually shifts.

### Per-phase verification (no full regression fire)
- **Phase 1:** only new tests + the reducer invariant assertion + the pause-reason-mapping cross-product test (red on the 6 lossy rows). If anything red, it's the *documentation* of today's inconsistency (or the demonstrated Tension-1 hazard) — no production code changed.
- **Phase 1.5:** the reducer invariant test goes green; the pause-reason-mapping test goes **green on all 10 rows** (the explicit map + 5 new BlockedReason values fix the lossy fallback); crucially, **`index.ts` is untouched**, so all 704 tests still exercise the old setter path and must stay green. Two truths hold simultaneously: reducer-alone is consistent, and setter-path is unchanged.
- **Phase 2:** golden-master characterization suite (frozen before 2a, captured at the index.ts/projection boundary — §Phase boundary caveat) compared commit-by-commit. Each sub-step ships only when its paired test + the full suite are green. The Phase-1 invariant assertion is progressively un-skipped.
- **Phase 3:** typecheck + build + lint gate; the test suite no longer references deleted setters.

### Critical regression-guard test files (the safety net subset)
These are the files that must stay green at every commit; if one regresses outside its owning sub-step, **stop**:

| File | Guards against |
|---|---|
| `tests/orchestrator.test.ts` | reducer internal consistency (the invariant assertion lives here) |
| `tests/derive-status.test.ts` *(new)* | the full `(orchState × blockedReason × flags)` derivation table — the spec for `deriveStatus` |
| `tests/pause-reason-mapping.test.ts` *(new)* | **TENSION 1** — the 10-row `PauseReason → BlockedReason` map; goes red on the 6 lossy rows pre-Phase-1.5 |
| `tests/evidence-wiring.test.ts:198-204` | **the H1 bug** — failed evidence must not yield `status:'done'` |
| `tests/evidence-gate.test.ts` + `tests/e2e/evidence-gate-execfile.e2e.test.ts` | evidence pass/fail/skip → status mapping end-to-end |
| `tests/orchestrator-integration.test.ts` | activate/resume/stop gateway wiring + orchState in projection |
| `tests/projection.test.ts` + `tests/m2-types-projection.test.ts` | **public projection contract** (canStop/modelTier/thinkingIntensity) — captured at the index.ts/projection boundary |
| loop-breaker e2e *(new, 2f)* | **TENSION 3 / pre-mortem #2** — branch A (recoverable → retry_queued) + branch B (terminal → blocked/paused) |
| `tests/autopilot-concurrency.test.ts` | `status==='running'` count boundary at `maxConcurrent` (W1 must not disturb). **Note:** the cross-activate TOCTOU (pre-mortem #3, revised) is out of scope for W1 — see §3. |
| `tests/autopilot-activate-idempotent.test.ts` | activate from idle/done/stuck-recovery |
| `tests/autopilot-stop-meta-cleanup.test.ts` | stop→idle + cleanup |
| `tests/production-hardening.test.ts` | max_total pause + degraded paths |
| `tests/e2e/lifecycle.e2e.test.ts` | full activate→run→done cycle |
| `tests/tier1-type-safety.test.ts` | type-level guarantees on state shape |

### Explicitly out of scope
- W2 (`needsCrossTurnResume`) — touched only where a spread would clobber derived status; full collapse deferred.
- M1/M2/M3 from the audit — separate fix items, recorded as ADR follow-ups.
- Host-side integration (not visible in this repo) — the projection contract freeze is the mitigation.
