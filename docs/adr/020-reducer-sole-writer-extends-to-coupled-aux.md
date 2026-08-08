# ADR-020: Reducer sole-writer extends to coupled aux fields

## Status

**Accepted / partially implemented** (2026-08-06, implementation in progress 2026-08-07). Companion design detail lives in the authoritative design doc: MatrixAssistant `docs/core/autopilot/design.md` [§8.2.1](../../../../MatrixAssistant/docs/core/autopilot/design.md). This ADR records the decision; implementation is a 6-step incremental migration.

**Migration progress** (see Follow-ups for the step list):

| Step | Scope | State |
|---|---|---|
| 1 | `cross_turn_degraded` event + migrate spread `index.ts:1058` | **done** (`b4652b0`, race fix `693cda7`) |
| 2 | clear `needsCrossTurnResume` via reducer (was spread `index.ts:530`) | **done** (`db94b1c`) — see the lifecycle correction under Decision 5 |
| 3 | `evidence_finished` race-warn + delete `complete()` call site | **done** (`052d2d0` pins the reducer no-op; `6f2cd7f` removes the caller backdoor) |
| 4 | fold `activate`/`pause`/`resume` setters | **partial** (`a534c60`: activate/pause/deactivate folded; `resume` deferred → E4/P1-8) |
| 5 | fold `deactivate` → `stop_requested`; delete `complete()` | **partial** (`a534c60`: `stop_requested` carries aux resets; `complete()` already zero-callers) |
| 6 | delete throw-guards + apology comments; add 6-aux invariant | pending (E13-gated — see below) |

Steps 4/5 landed the transition folds for `activate`/`pause`/`deactivate`
(`a534c60`) plus the `degraded` flag-lifecycle events `degradation_marked` /
`degradation_cleared` (`0bc9304`), so the reducer is now sole writer of
`enabled` / `pauseReason` / `toolErrorCount` / `lastToolError` / `degraded`.
Still outstanding: `resume` (deferred to E4 — its setter force-claims past the
reducer's resumability guard); the two `needsCrossTurnResume` bare spreads
(deferred to E13/P3-29 — they are the cross-turn handshake); setter deletion +
throw-guards + the full 6-aux invariant (blocked on `needsCrossTurnResume`
becoming reducer-only).

## Context

[ADR-016](016-autopilot-status-sole-writer.md) made the orchestrator reducer the sole writer of **one** field — `status` — and explicitly scoped the decision:

> The reducer is NOT the sole writer of the 5 other coupled fields (`enabled`, `pauseReason`, `toolErrorCount`, `needsCrossTurnResume`, `degraded`). `resume()` remains a writer of those fields. Do not over-read "sole writer" as covering the whole state object.

That boundary was deliberate at the time — it closed the H1 dual-`status` bug without committing to a larger refactor. But the 5 imperative setters (`activate/pause/complete/resume/deactivate` in `autopilot-state.ts`) and 3 bare `{...state}` spreads (`index.ts:530/905/1058`) still write scheduling state outside the reducer. The reducer header still claims sole-writer; the claim is still false for everything except `status`.

The friction this causes (surfaced by the 2026-08-06 architecture review, candidate #1):

- **H1-class residual.** `complete()` is a backdoor around the reducer's `released` guard. When evidence arrives but `orchestrationState !== 'released'` (a stop/stall/retry race), the reducer no-ops and `index.ts:658` calls `complete()` to force `done` anyway — masking the race as a completion.
- **Bug locality.** The wiring bugs (PROD-7, LOGIC-4, H1, GAP-*) cluster in the 1000-line `index.ts register()` closure precisely because transition logic and its aux resets are split across the reducer, the setters, and inline spreads.
- **Self-admitted debt.** `autopilot-state.ts:14-16` says "Phase 3 will remove them once all call sites dispatch reducer events and the reducer is the sole writer." The design doc records this as active risk S-1 and tech debt TD-3.

The 5 setter field-write matrix (verified by reading every setter):

| setter | reducer-domain fields | coupled aux fields |
|---|---|---|
| `activate` | orchState=`unclaimed`, blockedReason=`undef` | `enabled=true` |
| `pause(r)` | orchState=`blocked`, blockedReason=mapped | `enabled=false`, `pauseReason=r`, `needsCrossTurnResume=false` |
| `resume` | orchState=`claimed`, blockedReason=`undef` | `enabled=true`, `pauseReason=undef`, `toolErrorCount=0`, `lastToolError=undef`, `needsCrossTurnResume=false`, `degraded=false` |
| `complete` | orchState=`done` | `enabled=false`, `needsCrossTurnResume=false`, `degraded=false` |
| `deactivate` | orchState=`blocked`, blockedReason=`user_stopped` | `enabled=false`, `pauseReason=undef`, `needsCrossTurnResume=false`, `degraded=false` |

The aux resets are not independent of the transition — `resume` clearing `toolErrorCount` is one decision with `resume`'s transition, not two.

## Decision

**The reducer becomes the sole writer of the 6 coupled aux fields, by extension of ADR-016's scope.** Concretely: `enabled`, `pauseReason`, `toolErrorCount`, `lastToolError`, `needsCrossTurnResume`, `degraded` join `orchestrationState`/`blockedReason`/`status` as reducer-derived. Transition events carry their coupled aux resets atomically — one event, one transition, one reset.

`permissionAudit` is **explicitly excluded** — it is an observation ring buffer, not state-machine state, and remains an index.ts-owned write. This is the aux boundary ADR-016 envisioned.

### Five load-bearing decisions (grilling outcome)

1. **Aux resets ride into the reducer** (not a separate index.ts concern). Transition and reset are one decision; the reducer is the right home because it is where transition complexity already lives.
2. **`complete()` is deleted.** The single path to `done` is the reducer's `evidence_finished` branch. When evidence arrives but `orchestrationState !== 'released'`, the reducer **warns and preserves `orchestrationState`** rather than completing — surfacing the stop/stall race instead of masking it. The `released` guard is a real safety gate (it prevents evaluating evidence in a state not meant for it); `complete()` was its backdoor.
3. **Throw-guards become warn + no-op.** The reducer stays a pure function (no throws across the dispatch boundary). The bug-detection value of the setters' `if (status !== X) throw` guards is preserved as a warning trail, consistent with #2's warn-don't-mask posture.
4. **`permissionAudit` stays an index.ts spread.** Event-ing a log ring buffer would treat observation as state transition. This fixes the aux boundary: reducer owns transition + transition-coupled reset; index.ts owns observation.
5. **Event vocabulary reuses existing events; one new event.** `activate_requested` / `pause_requested` / `resume_requested` / `stop_requested` (for `deactivate`) already exist and carry the transitions. The degraded cross-turn fallback (`index.ts:1058`) becomes a new `cross_turn_degraded` event carrying `totalContinuations++`, `needsCrossTurnResume=true`, `turnAttempts=0`, `degraded=true`.

   **Lifecycle correction (implementation, 2026-08-07).** This decision originally said `agent_turn_started` would gain the `needsCrossTurnResume=false` reset (replacing `index.ts:530`). That is the wrong hook: the flag is the host-driver handshake, and clearing it at turn *start* re-arms the infinite chat.send loop the flag exists to prevent. The reset therefore ships as a **second new event, `cross_turn_resume_consumed`, dispatched from `before_agent_finalize`** — the point at which the resumed turn is finalizing and the handshake is genuinely consumed. Net: **two** new events, not one. Pinned by `tests/orchestrator-cross-turn-resume-consumed.test.ts`.

## Drivers

- **Close the doc's own debt.** S-1 (active risk) and TD-3 (tech debt) both name the ~10 spreads as a long-term governance goal; this ADR is that governance.
- **Locality.** Transition logic, its guards, and its aux resets converge in one module. The `index.ts:644-658` dual-`done` apology and the H1 backdoor class cannot occur — there is one writer.
- **Testability.** Every transition (and its aux reset) becomes exercisable through the reducer's `(state, event) → state` interface, instead of the current mix where setter paths can only be tested by driving index.ts.
- **ADR-016 completion.** ADR-016 left the scope open ("do not over-read sole-writer as covering the whole state object"); this ADR resolves the open question for the coupled fields.

## Alternatives considered

- **Option B (aux resets stay as index.ts spreads).** Rejected — it preserves the dual-writer bug class for the 6 coupled fields. The whole point is to close it.
- **Option C (separate `aux_cleared` events).** Rejected — it splits one atomic decision (transition + reset) across two events whose ordering must guarantee atomicity. Fragile, and the reducer ends up larger anyway.
- **Relaxing the `released` guard (instead of deleting `complete()`).** Rejected — the guard is a safety gate, not an optimization. Evidence evaluated outside `released` is the race; relaxing hides it.
- **Big-bang migration.** Rejected on risk. A 6-step incremental migration with dual-track cutover (each setter folds after its event is in place) keeps every step independently shippable and bisectable.

## Consequences

**Positive:**
- H1-class residual (the `complete()` backdoor masking the stop/stall race) structurally eliminated. **Realized in step 3** — `index.ts` has zero `complete()` callers; evidence outside `released` now warns and preserves orchState.
- One writer for transition + coupled aux; the dual-`done` path and the apologetic comments delete with it.
- Reducer's depth increases — it absorbs transition-coupled reset policy, which is where that policy belongs.

**Negative:**
- The reducer grows. Aux-clear policy (which fields each transition resets) moves from setters into reducer event handlers. This is the right trade (the reducer is the deep module) but it is growth.
- Behavior change on the race path: runs that today silently complete via the `complete()` backdoor will instead warn and stay in their pre-race state. This is correct (the completion was erroneous) but is an observable change that the race-warn test must pin.
- Migration touches ~22 setter call sites + 3 spreads across `index.ts`. Dual-track cutover (event added before setter deleted) mitigates but does not eliminate the diff size.

## Enforcement

Same posture as ADR-016: single-writer enforced by test gate + machine-checked invariant, not by structural impossibility (the POJO state is spread ~30 times). The existing `tests/status-invariant.test.ts` extends to assert the 6 coupled aux fields are only written by reducer event handlers; a stray setter call or spread is caught at test time.

## Follow-ups

- ~~**Step 1**: add `cross_turn_degraded` event + reducer handler; migrate `index.ts:1058` to dispatch it (dual-track).~~ **Done.** Implementation surfaced a call-site race the reducer guard alone could not close: the degraded path `await`s `enqueueNextTurnInjection` before dispatching, so a concurrent stop/pause/stall could move the run off `running` after the host had already queued the cross-turn — the guard then no-oped while a false success warn fired. Fixed at the call site (re-check status after the await; skip the dispatch and emit a race warn) and pinned in `tests/plugin-entry.test.ts`.
- ~~**Step 2**: clear `needsCrossTurnResume` through the reducer.~~ **Done** as `cross_turn_resume_consumed` at `before_agent_finalize` (see the Decision 5 lifecycle correction).
- ~~**Step 3**: `evidence_finished` race-warn + delete `complete()`.~~ **Done.** The reducer no-op is pinned by `tests/evidence-finished-race-pin.test.ts`; the `index.ts` caller backdoor is removed, so the single path to `done` is now the reducer. Removing it required migrating 8 tests across 4 files that drove completion without firing `agent_turn_prepare` — their runs sat in `claimed` and reached `done` only via the backdoor. `complete()` remains exported from `autopilot-state.ts` (still unit-tested) but has zero production callers.
- **Steps 4-6**: fold the `activate`/`pause`/`resume`/`deactivate` setters, then delete the throw-guards and apology comments. Order recorded in design doc §8.2.1. **Partial** as of 2026-08-08: `activate`/`pause`/`deactivate` folded (`a534c60`); `resume` deferred to E4 (its setter bypasses the reducer's resumability guard — P1-8); the two `needsCrossTurnResume` bare spreads deferred to E13 (they are the P3-29 cross-turn handshake); setter deletion + the 6-aux invariant blocked on `needsCrossTurnResume`.
- **Event vocabulary extension (step 4, 2026-08-08)**: Decision #5 enumerated one new event (`cross_turn_degraded`, +`cross_turn_resume_consumed` via the lifecycle correction). Step 4 added two more — `degradation_marked` / `degradation_cleared` (`0bc9304`) — to fold the agent_end `degraded` flag-lifecycle (canary-failed → `degraded:true`; canary-fired recovery → `degraded:false`) into the reducer. These are pure flag flips with **no orchState transition**, a shape Decision #1's "one event, one transition, one reset" framing did not contemplate. It is ticket-authorized (E12) and mirrors the original bare spreads exactly — including deliberately NOT advancing `lastActivityAt` (`degradation_marked` fires when the run is stalled; stamping activity would mask the stall detector). Recorded here so the ADR lists its own implemented vocabulary.
- **ADR-016 follow-up W1a** ("route the 8 setter call sites through reducer events") is subsumed by this ADR's migration.
- ~~**Race-warn observability**: the new warn on evidence-outside-`released` should be observable enough that a mis-ordered upstream is diagnosable, not just silenced.~~ **Done** — the warn names the evidence status, `orchestrationState` and `status`.
- **Enforcement gap (open)**: `tests/status-invariant.test.ts` does not yet assert that the 6 coupled aux fields are reducer-only (see Enforcement). Until steps 4-6 land, that invariant would fail by construction — the remaining setters and spreads are still writers. Add the assertion as part of step 6.

## Related

- [ADR-016](016-autopilot-status-sole-writer.md) — the parent decision whose scope this extends
- [Design doc §8.2.1](../../../../MatrixAssistant/docs/core/autopilot/design.md) — full grilling detail, event vocabulary, migration order
- [Architecture review 2026-08-06](../../../../MatrixAssistant/.omc/research/) — candidate #1 of the read-only architecture walk (HTML report in OS temp dir)
- S-1 / TD-3 in the design doc — the acknowledged debt this closes
