# ADR-016: Autopilot `status` is a derived, sole-writer field

## Status

Accepted (2026-07-04).

## Context

`AutopilotState.status` was historically written by three independent mechanisms:
1. `autopilot-state.ts` — 5 throw-based setters (activate/pause/complete/resume/deactivate)
2. `orchestrator.ts` reducer — wrote status in some branches (activate, evidence passed)
3. `index.ts` — direct `{...state, status:...}` spreads

The reducer header claimed "Single-writer constraint: all state transitions go through this reducer" — this was false. The dual-writer disagreement was the root cause of H1 (evidence gate false completion, fixed in #75): the reducer set `orchestrationState='retry_queued'` on evidence failure but left `status='running'`, and `index.ts` branched on the stale `status`, calling `complete()` and producing a false "done".

## Decision

`AutopilotState.status` is a stored field, but the orchestrator reducer is its sole writer **of the `status` field**. Every reducer return path computes `status` via the pure `deriveStatus(state)` function, which maps `orchestrationState` + `blockedReason` to the canonical status. The 5 throw-based setters also derive (they call `deriveStatus` on their result rather than hardcoding), but the reducer is the authoritative derivation point.

**Sole-writer is status-only (explicit scope).** The reducer is NOT the sole writer of the 5 other coupled fields (`enabled`, `pauseReason`, `toolErrorCount`, `needsCrossTurnResume`, `degraded`). `resume()` remains a writer of those fields. Do not over-read "sole writer" as covering the whole state object.

> **Superseded in scope by [ADR-020](020-reducer-sole-writer-extends-to-coupled-aux.md)** (2026-08-06, implementing): that ADR extends sole-writer to those coupled aux fields (plus `lastToolError`), resolving the open question this paragraph deliberately left. `status`-only remains accurate for the un-migrated call sites — see ADR-020's migration progress table for what has actually converged.

**Enforcement**: single-writer + machine-checked invariant + test gate — not structurally impossible. A stray `{...state, status:'x'}` spread compiles but is caught by `tests/status-invariant.test.ts` (`status === deriveStatus(state)` after every setter + reducer event). This is the strongest practical enforcement for a POJO state object that is spread ~30 times.

## PauseReason → BlockedReason mapping

The `pauseReasonToBlockedReason` function is **total** (exhaustive switch, no fallback parameter — an unhandled PauseReason is a compile error). 6 new BlockedReason values were added (`max_total_reached`, `tool_error_repeated`, `loop_breaker_triggered`, `context_overflow_unrecoverable`, `injection_rejected`, `unrecoverable_error`) so that no PauseReason collapses to the lossy `'validation_failed'` fallback (which is resumable — making terminal pauses look recoverable).

`RESUMABLE_BLOCKED_REASONS = {stalled, validation_failed, evidence_missing, injection_rejected}`. The `injection_rejected` addition is deliberate: a refused cross-turn injection is transient and user-resumable.

## Drivers

- **H1 prevention**: the dual-writer disagreement was the direct root cause. Deriving status from a single pure function makes disagreement structurally impossible.
- **Test safety net**: 690→771 existing tests + 78 new derivation/invariant/mapping tests form the regression net.
- **Projection contract**: hosts consume `AutopilotProjection.status` — the derivation is frozen by `tests/derive-status.test.ts` (exhaustive orchState × blockedReason table).

## Alternatives considered

- **Option A (getter on state object)**: rejected — JS getters don't survive `{...state}` spread (~30 sites), so the field would silently re-stale.
- **Option C (incremental thin-wrapper as end state)**: rejected as end state (preserves dual-writer illusion) but adopted as the transition mechanism (setters derive during the migration).

## Consequences

**Positive:**
- H1-class bug (status/orchState disagreement) structurally eliminated.
- `status` is always a pure function of `orchState + blockedReason` — debuggable, predictable.
- Adding a new PauseReason without a BlockedReason mapping is a compile error (total function).

**Negative:**
- 6 new BlockedReason values widen the public `AutopilotProjection.blockedReason` union (additive, minor-version semver consideration).
- The throw-based setters remain in production (W1a: 8 call sites not yet routed to reducer events). They derive consistently today, but the hybrid authoring style is a maintainability watch item.

## Follow-ups

- **W1a**: route the 8 setter call sites through reducer events (production index.ts still calls setters directly).
- **W2**: collapse `needsCrossTurnResume` (16 write sites, 3 semantics) — orthogonal to status, tracked separately.
- **W1c**: loop-breaker branch-A/B e2e test (circuit-breaker errors are non-recoverable per `classifyRecoverability`, so branch-A is largely unreachable).

## Related

- [H1 fix (PR #75)](https://github.com/TeFuirnever/oh-my-matrix/pull/75) — evidence gate false completion
- [W1 collapse (PR #76)](https://github.com/TeFuirnever/oh-my-matrix/pull/76) — this ADR's implementation
- [H1+W1 collision fix (PR #80)](https://github.com/TeFuirnever/oh-my-matrix/pull/80) — follow-up regression
- [Correctness review](../audits/autopilot-correctness-review-2026-07-04.md) — the audit that surfaced W1
- [Fix checklist Wave 5](../audits/autopilot-fix-checklist.md) — tracks W1a/W1c follow-ups
