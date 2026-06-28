# ADR-013: Extract `@openclaw/permission-policy` as a Neutral Library

## Status

> **⚠ KNOWN BUG (found 2026-06-27 by adversarial review, NOT STARTED):** The shipped
> guard is **fail-open in production** — it reads `event.args` / `event.toolKind`, which
> do not exist on the real OpenClaw event (the real shape is `params: Record` +
> `toolKind: "code_mode_exec"` only). The component tests pass only because they feed a
> fictional event shape the host never emits. The "verified / works" claims in this ADR
> and in the §11.3.3 / §11.8 B1 design-doc rows **predate this finding and are wrong**.
> Fix spec: [`docs/fixes/runtime-guard-event-shape.md`](../fixes/runtime-guard-event-shape.md).
> This bug is PRE-EXISTING (from MA's autopilot, migrated in `be05e49`); ADR-011/012/013
> inherited it. The decoupling itself (the architectural work this ADR records) is sound;
> the guard's event-shape plumbing is what's broken.

Accepted (2026-06-27). **Refines [ADR-012](012-dynamic-workflows-plugin-extraction.md)**
— the runtime guard stays in `@openclaw/dynamic-workflows`, but the shared permission
**primitives** move out into a dedicated neutral library. Resolves the plugin-to-plugin
coupling ADR-012 introduced.

## Context

ADR-012 extracted the subagent guard into `@openclaw/dynamic-workflows` but left that
package **dual-purpose**: it was both (1) a runtime guard plugin (`before_tool_call`
priority 11) AND (2) the owner of the shared permission primitives (`decidePermission`,
`classifyCommand`, audit-persister), re-exported for `@openclaw/autopilot` to consume.
Consequently `@openclaw/autopilot` declared `@openclaw/dynamic-workflows` as a
peerDependency + devDependency — a **plugin-to-plugin package coupling** (build-time
only, via peerDep, but a conceptual smell: dynamic-workflows wore two hats).

A third ralplan consensus loop (Planner/Architect/Critic) evaluated decoupling. The
**Critic returned ITERATE** on the first plan over a naming concern (which investigation
resolved: there was no name-rewrite mechanism — the `@omm→@openclaw` rename was simply
not yet distributed to MA). Direction was agreed by all three agents.

## Decision

**Extract `@openclaw/permission-policy` as a neutral LIBRARY (not a plugin).** Move
`permission-policy.ts`, `audit-persister.ts`, and the shared `types.ts`
(`CommandClass`, `PermissionAuditEntry`, `PermissionDecisionInput`) out of
`@openclaw/dynamic-workflows` into the new package. Both `@openclaw/autopilot` and
`@openclaw/dynamic-workflows` depend on it as a **peerDependency** (the proven pattern —
a regular dep would 404 at MA install, the same failure that forced peerDep originally).
**Neither plugin depends on the other.**

### Why a library, not a plugin

A library is ~2 MA distribution artifacts (root `file:` dep + vendored tgz) vs a plugin's
~4 (+ build script + bundled-plugin copy + discovery + openclaw.plugin.json + hooks). The
library is `require()`d at runtime from the plugins' dist via Node's upward walk to MA
root `node_modules` — verified by `require.resolve` from both
the host's bundled-plugin directory for autopilot and for dynamic-workflows.

### Why peerDep, not regular dep (Architect's correction)

`@openclaw/permission-policy` is not on the npm registry. A regular dep in autopilot's
tgz would make pnpm try the registry (404) during MA install. peerDep + MA root `file:`
dep is the arrangement that works (pnpm hoists the root instance into each plugin's
scoped node_modules). Both plugins declare it peerDep `0.1.0` + devDep `workspace:*`
(the devDep is stripped from the packed tgz, so MA only sees the peer).

### SDK alternative — rejected

Grep for `decidePermission`/`classifyCommand` across `openclaw/dist/` returns **0 matches**.
The logic is opinionated application policy (the blacklist-fall-through at
`permission-policy.ts:280` is a project decision tied to OpenProse/autopilot UX), not a
platform invariant. The OpenClaw SDK correctly refuses to own it.

## Consequences

**Positive:**
- **True plugin independence.** `@openclaw/autopilot` and `@openclaw/dynamic-workflows`
  no longer reference each other (verified: `grep -c dynamic-workflows` in autopilot's
  dist = 0). Each is independently installable (given the lib).
- **Single source of truth.** The permission policy + audit primitives live in one place;
  both consumers import the same code (no drift).
- **dynamic-workflows wears one hat** (the guard plugin), not two.
- **Library distribution is light** — no MA build script, no claw-plugin copy, no
  discovery registration.

**Negative:**
- A 3rd omm package (`@openclaw/permission-policy`) + a 3rd MA root `file:` dep.
- `AUDIT_SUBDIR = '.autopilot'` stays hardcoded in v1 (deferred parameterization — let
  a real 3rd consumer drive the API shape; avoid guessing now).

## Verification (2026-06-27)

- `@openclaw/permission-policy`: 105 tests pass (`permission-policy` 91 + `audit-persister` 14).
- `@openclaw/dynamic-workflows`: 8 tests pass (subagent-guard; imports primitives from the lib).
- `@openclaw/autopilot`: 528 pass | 4 skipped (imports primitives from the lib; zero regression).
- MA: `require.resolve('@openclaw/permission-policy', {paths:['<MA>/<bundled-plugin-dir>/autopilot/dist']})`
  AND from the dynamic-workflows bundled-plugin dist → both succeed.
- `grep -c dynamic-workflows` in the host's autopilot plugin dist = **0**
  (full severance).

## Follow-ups

- When a 3rd consumer of the primitives appears: parameterize `AUDIT_SUBDIR`; review
  whether the v1 API (5 functions + 3 types) needs a config object.
- Generalize the per-plugin MA build scripts (`build-{autopilot,dynamic-workflows,audit}-plugin.js`)
  into a parameterized helper once a 4th plugin lands.

## Related ADRs

- **Refines [ADR-012](012-dynamic-workflows-plugin-extraction.md)** — the guard stays in
  dynamic-workflows; only the primitives move further out.
- [ADR-010](010-autopilot-source-hosting.md) — the plugin-hosting monorepo vision.

## References

- Plan: [`.omc/plans/decouple-permission-policy.md`](../../.omc/plans/decouple-permission-policy.md)
  (ralplan: Planner→Architect→Critic ITERATE→resolved)
- Implementation: `packages/permission-policy/`, `packages/dynamic-workflows/index.ts`,
  `packages/autopilot/index.ts` (all import from `@openclaw/permission-policy`)
