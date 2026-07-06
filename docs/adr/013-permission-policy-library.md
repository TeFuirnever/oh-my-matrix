# ADR-013: Extract `@oh-my-matrix/permission-policy` as a Neutral Library

## Status

> **✅ Previously-known bug FIXED 2026-06-28** (`e178c34`, see
> [`docs/fixes/runtime-guard-event-shape.md`](../fixes/runtime-guard-event-shape.md)):
> the shipped guard was a **placebo in production** — it read `event.args` /
> `event.toolKind`, which do not exist on the real OpenClaw event (real shape is
> `params: Record` + `toolKind: "code_mode_exec"`), so it failed OPEN. Component
> tests passed only because they fed a fictional event shape. Fixed by capturing
> the real event shape first, then teaching the guard + tests to read it;
> verified via deployed-dist `verify-guard` driving the real shape (destructive
> / `cd && git reset --hard` / `rm -rf` blocked; `git status` / main-session
> allowed). This bug was PRE-EXISTING (from the host's autopilot, migrated in
> `be05e49`); ADR-011/012/013 inherited it. The decoupling itself (the
> architectural work this ADR records) was always sound; the guard's event-shape
> plumbing was the broken part, fixed as of 2026-06-28.

Accepted (2026-06-27). **Refines [ADR-012](012-dynamic-workflows-plugin-extraction.md)**
— the runtime guard stays in `@oh-my-matrix/dynamic-workflows`, but the shared permission
**primitives** move out into a dedicated neutral library. Resolves the plugin-to-plugin
coupling ADR-012 introduced.

## Context

ADR-012 extracted the subagent guard into `@oh-my-matrix/dynamic-workflows` but left that
package **dual-purpose**: it was both (1) a runtime guard plugin (`before_tool_call`
priority 11) AND (2) the owner of the shared permission primitives (`decidePermission`,
`classifyCommand`, audit-persister), re-exported for `@oh-my-matrix/autopilot` to consume.
Consequently `@oh-my-matrix/autopilot` declared `@oh-my-matrix/dynamic-workflows` as a
peerDependency + devDependency — a **plugin-to-plugin package coupling** (build-time
only, via peerDep, but a conceptual smell: dynamic-workflows wore two hats).

A third ralplan consensus loop (Planner/Architect/Critic) evaluated decoupling. The
**Critic returned ITERATE** on the first plan over a naming concern (which investigation
resolved: there was no name-rewrite mechanism — the `@omm→@openclaw` rename was simply
not yet distributed to the host). Direction was agreed by all three agents.

## Decision

**Extract `@oh-my-matrix/permission-policy` as a neutral LIBRARY (not a plugin).** Move
`permission-policy.ts`, `audit-persister.ts`, and the shared `types.ts`
(`CommandClass`, `PermissionAuditEntry`, `PermissionDecisionInput`) out of
`@oh-my-matrix/dynamic-workflows` into the new package. Both `@oh-my-matrix/autopilot` and
`@oh-my-matrix/dynamic-workflows` depend on it as a **peerDependency** (the proven pattern —
a regular dep would 404 at host install, the same failure that forced peerDep originally).
**Neither plugin depends on the other.**

### Why a library, not a plugin

A library is ~2 host distribution artifacts (root `file:` dep + vendored tgz) vs a plugin's
~4 (+ build script + bundled-plugin copy + discovery + openclaw.plugin.json + hooks). The
library is `require()`d at runtime from the plugins' dist via Node's upward walk to the host
root `node_modules` — verified by `require.resolve` from both
the host's bundled-plugin directory for autopilot and for dynamic-workflows.

### Why peerDep, not regular dep (Architect's correction)

`@oh-my-matrix/permission-policy` is not on the npm registry. A regular dep in autopilot's
tgz would make pnpm try the registry (404) during host install. peerDep + the host root `file:`
dep is the arrangement that works (pnpm hoists the root instance into each plugin's
scoped node_modules). Both plugins declare it peerDep `0.1.0` + devDep `workspace:*`
(the devDep is stripped from the packed tgz, so the host only sees the peer).

### SDK alternative — rejected

Grep for `decidePermission`/`classifyCommand` across `openclaw/dist/` returns **0 matches**.
The logic is opinionated application policy (the blacklist-fall-through at
`permission-policy.ts:280` is a project decision tied to OpenProse/autopilot UX), not a
platform invariant. The OpenClaw SDK correctly refuses to own it.

## Consequences

**Positive:**
- **True plugin independence.** `@oh-my-matrix/autopilot` and `@oh-my-matrix/dynamic-workflows`
  no longer reference each other (verified: `grep -c dynamic-workflows` in autopilot's
  dist = 0). Each is independently installable (given the lib).
- **Single source of truth.** The permission policy + audit primitives live in one place;
  both consumers import the same code (no drift).
- **dynamic-workflows wears one hat** (the guard plugin), not two.
- **Library distribution is light** — no host build script, no claw-plugin copy, no
  discovery registration.

**Negative:**
- A 3rd omm package (`@oh-my-matrix/permission-policy`) + a 3rd host root `file:` dep.
- `AUDIT_SUBDIR = '.autopilot'` stays hardcoded in v1 (deferred parameterization — let
  a real 3rd consumer drive the API shape; avoid guessing now).

## Verification (2026-06-27)

- `@oh-my-matrix/permission-policy`: 105 tests pass (`permission-policy` 91 + `audit-persister` 14).
- `@oh-my-matrix/dynamic-workflows`: 8 tests pass (subagent-guard; imports primitives from the lib).
- `@oh-my-matrix/autopilot`: 528 pass | 4 skipped (imports primitives from the lib; zero regression).
- Host: `require.resolve('@oh-my-matrix/permission-policy', {paths:['<host>/<bundled-plugin-dir>/autopilot/dist']})`
  AND from the dynamic-workflows bundled-plugin dist → both succeed.
- `grep -c dynamic-workflows` in the host's autopilot plugin dist = **0**
  (full severance).

## Follow-ups

- When a 3rd consumer of the primitives appears: parameterize `AUDIT_SUBDIR`; review
  whether the v1 API (5 functions + 3 types) needs a config object.
- Generalize the per-plugin host build scripts (`build-{autopilot,dynamic-workflows,audit}-plugin.js`)
  into a parameterized helper once a 4th plugin lands.

## Related ADRs

- **Refines [ADR-012](012-dynamic-workflows-plugin-extraction.md)** — the guard stays in
  dynamic-workflows; only the primitives move further out.
- [ADR-010](010-autopilot-source-hosting.md) — the plugin-hosting monorepo vision.

## References

- Plan: [`.omc/plans/decouple-permission-policy.md`](../../.omc/plans/decouple-permission-policy.md)
  (ralplan: Planner→Architect→Critic ITERATE→resolved)
- Implementation: `packages/permission-policy/`, `packages/dynamic-workflows/index.ts`,
  `packages/autopilot/index.ts` (all import from `@oh-my-matrix/permission-policy`)
