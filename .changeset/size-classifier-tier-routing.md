---
"@oh-my-matrix/autopilot": minor
---

Wire the task-size classifier into effort and model routing (ticket-04).

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
