# ADR-017: Subagent declared model wins over parent `subagentTier`

## Status

Accepted (2026-07-06).

## Context

`before_model_resolve` (autopilot) computes a `{ modelOverride }` for each agent run. For subagent sessions (`agent:<main>:subagent:<sub>`), it resolved the **parent** run and applied the parent's `subagentTier` unconditionally (`src/model-routing.ts:41-43`). The child's own model declaration — set via `.prose` `model:` or an agent-definition — was silently overridden whenever the parent had `modelIds` configured and the run was active.

This was flagged as a latent bug in [`autopilot-dynamic-workflows-boundary.md`](../design/autopilot-dynamic-workflows-boundary.md) §5.4 (INT-3), but left unresolved pending an open question: *does the OpenClaw host pass the subagent's own model intent to the hook?*

### Resolving the §5.4 open question

Investigation of the OpenClaw host (`MatrixAssistant/build/openclaw/`) confirmed:

- The host does **not** pass the child's workflow config object to `before_model_resolve`.
- It **does** surface the child's already-resolved declared model via `ctx.modelId` (`hook-types.d.ts:274-290`). `resolveHookModelSelection()` (`embedded-agent-runner/run.ts`) resolves the `.prose` `model:` declaration **before** firing the hook and seeds it into `hookContext.modelId`.
- The hook's return value (`modelOverride`) then overrides that declared model; returning `undefined` lets it stand.

So "child intent wins" is **implementable without a host change** — the hook can read `ctx.modelId` and choose not to override. The §5.4 blocker is dissolved.

## Decision

**A subagent's own declared model (`ctx.modelId`) wins; the parent run's `subagentTier` applies only as a fallback for subagents that declared nothing.**

### Implementation

A child-first guard in the `before_model_resolve` hook (`index.ts:696-702`), inserted after the `routing.modelIds` presence check and before `resolveModelTier`:

```ts
if (isSubagentSession(sessionKey) && ctx.modelId) {
  log(`[autopilot] before_model_resolve: session=${sessionKey} inherit child model=${ctx.modelId}`);
  return;  // no modelOverride → host keeps the child's declared model
}
```

The existing `resolveModelTier` → `resolveModelId` → `{ modelOverride }` path (lines 704-716) becomes the fallback, reached when the subagent declared nothing or the session is the main agent. `resolveModelTier` (`src/model-routing.ts`) is unchanged — its `isSubagent` branch still returns the parent tier, but the hook no longer consults it for subagents carrying a declared model.

### Routing precedence (revised)

For a subagent session under an active autopilot run with `modelIds` configured:

| Child declared model (`ctx.modelId`) | Result |
|---|---|
| present | **inherit** (no override) — child's declaration honored |
| absent | parent `subagentTier` applies (fallback) |

Main-agent routing is unaffected: tier routing (`initialTurnTier` / `validationTier` / `defaultTier`) still applies. The `modelIds`-unconfigured escape hatch (§6.3) is also unaffected.

## Drivers

- **Removes a silent footgun.** A workflow author writing `.prose` `model: opus` on a judging subagent would silently receive the parent's `subagentTier` (e.g. `budget`) with no warning. The boundary doc explicitly called this a potential bug.
- **Harness/skill-ification prerequisite.** An OMC-style harness treats each agent's declared model as the load-bearing primitive. Option A (parent silently overrides) breaks that primitive; Option B makes the child's declaration authoritative and the parent tier a graceful default — the correct semantics for a harness where skills/agents ship their own model declarations.
- **No host dependency.** Once `ctx.modelId` was confirmed to carry declared-not-pre-overridden intent, the fix is a ~6-line guard localized to one hook.
- **Minimal blast radius.** `resolveModelTier` and the other pure functions are untouched; the change only reorders precedence for the subagent-with-declared-model case.

## Alternatives considered

- **Option A (status quo / parent wins).** Rejected. Would freeze the silent-override footgun as a contract and contradict the harness-era primitive. Only acceptable as a freeze-and-document stopgap; since B is low-risk, there is no reason to defer.
- **Option C (`subagentRoutingMode: 'parent' | 'child-wins'` config).** Rejected as the default. Defers the architectural decision to per-deployment config, so the declared-model invariant is not universal and skills cannot rely on it. Carries the same `ctx.modelId` dependency as B plus schema/parser/types churn. Remains a viable forward path if a cost-circuit-breaker ever needs to force a tier for declared children (then default `'child-wins'` with an explicit operator override).

## Tradeoff

If a future feature needs the parent run to **force** a tier on declared children (e.g. a hard cost ceiling), Option B removes that capability for any child that declares a model. That capability is not needed today; if it becomes needed, Option C is the evolution path (config defaulting to `'child-wins'`), not a reversal of this decision.

## Tests

- `tests/plugin-entry.test.ts` "before_model_resolve hook (model routing)": 8 scenarios including the 3 INT-3 cases (child-wins inherit, child-absent parent fallback, main-agent unaffected).
- `resolveModelTier` pure-function coverage (`tests/model-routing.test.ts`) unchanged — the guard lives in the hook, not the pure function.

## Related

- [INT-3 / boundary §5.4](../design/autopilot-dynamic-workflows-boundary.md) — the original flag.
- [design §6.3–6.4](../design/model-routing-thinking-intensity-design.md) — the superseded "parent wins" precedence rule. This ADR revises it for the subagent case.
- [roadmap P5](../roadmap.md) — INT-3 follow-up row, now resolved.
