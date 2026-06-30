# ADR-012: Extract `dynamic-workflows` as a Second omm Plugin

## Status

Accepted (2026-06-27). **Supersedes [ADR-011](011-runtime-workflow-guard.md)** (which
shipped the runtime guard INSIDE `@oh-my-matrix/autopilot`).

> **Honesty note (2026-06-28):** the extracted guard was **fail-open in production**
> until [docs/fixes/runtime-guard-event-shape.md](../fixes/runtime-guard-event-shape.md).
> It read `event.args` / `event.toolKind` / `event.cwd`, none of which exist on the real
> OpenClaw `before_tool_call` event — so it silently allowed destructive ops. The "guard
> works" claim this ADR made was true only against fictional test shapes. Fixed + verified
> 2026-06-28 (real event shape captured live, tests rewritten, evasion paths closed).

## Context

[ADR-011](011-runtime-workflow-guard.md) shipped a runtime subagent guard as a branch
inside `@oh-my-matrix/autopilot`'s `before_tool_call` handler (Design 2). ADR-011 itself
flagged the conceptual mis-scope ("autopilot plugin enforcing dynamic-workflow safety
is a naming smell") and set extraction behind a revisit trigger: *"extract when a third
consumer of `decidePermission` materializes."*

A second ralplan consensus loop (2026-06-27) was convened on the user's proposal:
*"omm was designed as a single host plugin but is becoming a plugin collection — split
`workflow` out into its own plugin now."* That loop's **Critic approved a middle path**
(generalize the host-deploy step, **defer** extraction until the revisit trigger fires), on
verified findings:

- Host-side distribution is structurally per-plugin (3 copy-pasted
  `build-{autopilot,openviking,audit}-plugin.js` scripts; a 4th plugin = a 4th script).
- No third consumer of `decidePermission` exists in code (team-orchestration /
  employee-bridge are ADR prose only).
- ADR-011 was 1 day old; its trigger was explicitly not met.

**The user reviewed the consensus evidence and directed Option B (full extraction now)
anyway**, accepting the documented costs. This ADR records that decision.

## Decision

**Extract `dynamic-workflows` as the second omm plugin** at `packages/dynamic-workflows/`.
It owns the shared permission primitives + the subagent runtime guard. `@oh-my-matrix/autopilot`
becomes a CONSUMER of those primitives. The plugin registers `before_tool_call` at
**priority 11** so it runs before autopilot (10) and the host's audit plugin (9), and block
short-circuits the lower-priority handlers.

### What moved into `packages/dynamic-workflows/`

- `src/permission-policy.ts` — `decidePermission`, `classifyCommand` (pure, stateless,
  designed platform-level; the file's own header says so).
- `src/audit-persister.ts` — `appendAuditEntry`, `loadRecentAuditEntries`, `getAuditFilePath`.
- `src/types.ts` — `CommandClass`, `PermissionAuditEntry` (the shared types).
- `index.ts` — the plugin entry: `register(api)` registers `before_tool_call` (priority 11)
  with the `:subagent:` guard; also re-exports the library API consumed by autopilot.
- `tests/` — `permission-policy.test.ts`, `audit-persister.test.ts` (moved wholesale),
  `subagent-guard.test.ts` (new, expanded from ADR-011's inline tests).

### What stayed

- `@oh-my-matrix/autopilot` keeps its run-scoped `before_tool_call` handler (priority 10),
  now importing `decidePermission` / `classifyCommand` / `appendAuditEntry` from
  `@oh-my-matrix/dynamic-workflows`. Its `src/types.ts` re-exports `CommandClass` /
  `PermissionAuditEntry` so internal imports are unchanged.
- The SKILL pack stays at `skill/dynamic-workflows/` (teaching material, distributed via
  the host's `resources/skills/default/` skill sync). It is NOT inside the plugin package —
  content and runtime are separate distribution channels.

> **Update (2026-06-29):** the SKILL pack **moved into** `packages/dynamic-workflows/skill/`
> and now ships inside the `@oh-my-matrix/dynamic-workflows` npm package (added to `files`,
> v0.1.1). Hosts pull it from the registry instead of the separate `resources/skills/default/`
> hand-sync — single source of truth (the host-side vendored copy had drifted to a stale
> `@openclaw/*` name). This **partially supersedes** the "NOT inside the plugin package /
> separate distribution channels" claim above; the runtime-guard distribution is unchanged.

### Priority ordering (load-bearing)

OpenClaw runs `before_tool_call` handlers in descending priority order; `block` short-circuits
(`openclaw/src/plugins/hooks.ts:267,275,1562`, `shouldStop: result.block === true`):

| plugin | priority | role |
|---|---|---|
| `dynamic-workflows` | 11 | subagent guard — blocks destructive ops for `:subagent:` sessions, short-circuits |
| `@oh-my-matrix/autopilot` | 10 | run-scoped policy for autopilot runs (main sessions) |
| the host's audit plugin | 9 | audit |

The guard only fires on `:subagent:` session keys, so autopilot runs (main session) are
unaffected — the `WORKFLOW.md destructive_git.allow=true` escape hatch from ADR-011 still
works (it runs in autopilot's handler, which the guard skips for non-subagent sessions).

## Rationale

1. **Coherence.** The runtime guard + the primitives it uses live together; autopilot is
   one consumer, the guard another. ADR-011's in-plugin placement was an accident of
   history (autopilot already existed when the guard was added).
2. **Decouples safety from autopilot's lifecycle (resolves ADR-011 silent-degradation).**
   Under ADR-011, disabling autopilot silently disabled the workflow guard. Now the guard
   is a separate plugin; disabling autopilot does not affect it. The dynamic-workflows
   plugin's own `enabled: false` logs loudly (the one residual coupling).
3. **User direction overrides the consensus recommendation.** The ralplan Critic's
   middle-path verdict was evidence-based (host-side per-plugin cost, no third consumer, ADR
   recency). The user, informed of those costs, chose to pay them now for the coherent
   boundary + the suite positioning. This ADR honors that call.

## Consequences

**Positive:**
- Coherent workflow-plugin boundary; `@oh-my-matrix/dynamic-workflows` is the natural home for
  future workflow-runtime concerns.
- Safety decoupled from autopilot's on/off (ADR-011 silent-degradation resolved).
- Single source of truth for permission policy (both consumers import the same primitives).
- Realizes ADR-010's "omm as plugin-hosting monorepo" vision with a second concrete plugin.

**Negative:**
- Host-side distribution tax paid: a 4th hand-rolled build script
  (the host's), a 2nd `file:` dependency, a 2nd bundled-plugin directory,
  - plugin-discovery registration. This is the per-plugin cost the consensus flagged; it
  will recur for each future plugin until host-side build tooling is generalized.
- ~998 LOC of tests relocated/rewritten (`permission-policy.test`,
  `audit-persister.test` moved; `permission-wiring.test` split — subagent describe moved
  to the new package's `subagent-guard.test`; `tier4` + `m2-types-projection` re-pointed
  at `@oh-my-matrix/dynamic-workflows`).
- `audit-persister.ts` still writes to the `.autopilot/` subdir (cosmetic wart — both
  autopilot-run and subagent-guard audit share it, discriminated by `runId`). Renaming
  to a neutral subdir is a follow-up (would move existing audit files).
- Reverses ADR-011 one day after acceptance. ADR-011 is marked Superseded (not deleted) —
  it remains as the history of the in-plugin design + the revisit-trigger reasoning.

## Verification (2026-06-27)

- `@oh-my-matrix/dynamic-workflows`: 113 tests pass (`permission-policy` 91, `audit-persister` 14,
  `subagent-guard` 8). Guard runtime-logs confirm priority-11 block on `:subagent:`
  destructive git + `enabled:false` loud-degradation.
- `@oh-my-matrix/autopilot`: 528 tests pass | 4 skipped (was 637; −109 moved to
  dynamic-workflows: 91 + 14 + 4 subagent describe). Zero regression — autopilot-run
  policy + WORKFLOW.md escape hatch intact.
- Host distribution: (internal host-deploy step, not in this repo) produced a versioned file: tgz dependency,
  the host installed `@oh-my-matrix/dynamic-workflows 0.1.0`, `build:dynamic-workflows-plugin` copied to
  the host's bundled-plugin directory, the host's plugin-discovery module registers it.

## Follow-ups

- Generalize host-side plugin build into a parameterized helper (the consensus middle-path
  win, still worth doing) once a 3rd plugin lands — amortizes the per-plugin script cost.
- Rename `audit-persister`'s `.autopilot/` subdir to a neutral `.permission-audit/` (or
  parameterize) to remove the cosmetic wart.
- Live e2e in the host: spawn an OpenProse subagent that issues `git reset --hard`, confirm the
  dynamic-workflows plugin hard-blocks at the gateway (component tests pass; full host e2e
  is the final confirmation).

## Related ADRs

- **Supersedes [ADR-011](011-runtime-workflow-guard.md)** — the in-plugin guard design.
- [ADR-010](010-autopilot-source-hosting.md) — the plugin-hosting monorepo vision this realizes.
- [ADR-009](009-dynamic-workflows-via-openprose.md) — dynamic-workflows skill direction.

## References

- Plan: [`.omc/plans/split-workflow-plugin.md`](../../.omc/plans/split-workflow-plugin.md)
  (ralplan consensus: Planner→B, Architect→middle path, Critic→APPROVE middle path; user
  directed Option B)
- Implementation: `packages/dynamic-workflows/index.ts`, `packages/dynamic-workflows/src/`
- Consumer refactor: `packages/autopilot/index.ts` (imports from `@oh-my-matrix/dynamic-workflows`)
- Host distribution: the host's plugin build script,
  the host's plugin-discovery module
