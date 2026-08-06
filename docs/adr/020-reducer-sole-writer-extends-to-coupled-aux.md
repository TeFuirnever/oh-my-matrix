# ADR-020: Reducer sole-writer extends to coupled aux fields

## Status

**Proposed** (2026-08-06). Not yet implemented. Companion design detail lives in the authoritative design doc: MatrixAssistant `docs/core/autopilot/design.md` [§8.2.1](../../../../MatrixAssistant/docs/core/autopilot/design.md). This ADR records the decision; implementation is a 6-step incremental migration tracked separately.

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
5. **Event vocabulary reuses existing events; one new event.** `activate_requested` / `pause_requested` / `resume_requested` / `stop_requested` (for `deactivate`) already exist and carry the transitions. `agent_turn_started` gains a `needsCrossTurnResume=false` reset (was `index.ts:530`). The degraded cross-turn fallback (`index.ts:1058`) becomes a new `cross_turn_degraded` event carrying `totalContinuations++`, `needsCrossTurnResume=true`, `turnAttempts=0`, `degraded=true`.

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
- H1-class residual (the `complete()` backdoor masking the stop/stall race) structurally eliminated.
- One writer for transition + coupled aux; the dual-`done` path and the apologetic comments delete with it.
- Reducer's depth increases — it absorbs transition-coupled reset policy, which is where that policy belongs.

**Negative:**
- The reducer grows. Aux-clear policy (which fields each transition resets) moves from setters into reducer event handlers. This is the right trade (the reducer is the deep module) but it is growth.
- Behavior change on the race path: runs that today silently complete via the `complete()` backdoor will instead warn and stay in their pre-race state. This is correct (the completion was erroneous) but is an observable change that the race-warn test must pin.
- Migration touches ~22 setter call sites + 3 spreads across `index.ts`. Dual-track cutover (event added before setter deleted) mitigates but does not eliminate the diff size.

## Enforcement

Same posture as ADR-016: single-writer enforced by test gate + machine-checked invariant, not by structural impossibility (the POJO state is spread ~30 times). The existing `tests/status-invariant.test.ts` extends to assert the 6 coupled aux fields are only written by reducer event handlers; a stray setter call or spread is caught at test time.

## Follow-ups

- **Step 1**: add `cross_turn_degraded` event + reducer handler; migrate `index.ts:1058` to dispatch it (dual-track).
- **Steps 2-6**: the remaining migration order is recorded in design doc §8.2.1.
- **ADR-016 follow-up W1a** ("route the 8 setter call sites through reducer events") is subsumed by this ADR's migration.
- **Race-warn observability**: the new warn on evidence-outside-`released` should be observable enough that a mis-ordered upstream is diagnosable, not just silenced.

## Related

- [ADR-016](016-autopilot-status-sole-writer.md) — the parent decision whose scope this extends
- [Design doc §8.2.1](../../../../MatrixAssistant/docs/core/autopilot/design.md) — full grilling detail, event vocabulary, migration order
- [Architecture review 2026-08-06](../../../../MatrixAssistant/.omc/research/) — candidate #1 of the read-only architecture walk (HTML report in OS temp dir)
- S-1 / TD-3 in the design doc — the acknowledged debt this closes
