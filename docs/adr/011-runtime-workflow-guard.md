# ADR-011: Runtime Workflow Guard via the Autopilot Plugin

## Status

**Superseded by [ADR-012](012-dynamic-workflows-plugin-extraction.md) (2026-06-27)** —
the runtime guard was extracted out of the autopilot plugin into a dedicated
`@oh-my-matrix/dynamic-workflows` plugin. The in-plugin design recorded below is preserved
as history.

Accepted (2026-06-27). **Reverses the B1 conclusion recorded in
[`docs/design/dynamic-workflows-design.md`](../design/dynamic-workflows-design.md) §11.8**
(previously "disproven / ROI insufficient — accept prompt-only").

## Context

The `dynamic-workflows` SKILL teaches agents to generate `.prose` programs that
OpenProse executes by spawning subagent sessions. The SKILL's destructive-git
safety is a **prompt-level CHECKPOINT** (`SKILL.md:90-103`). Host real-world
testing showed **weak models (MiniMax-M2.7, glm-5.2) bypass prompt CHECKPOINTs** —
an inherent prompt-only ceiling. The original B1 investigation concluded
"real interception needs an OpenClaw plugin, ROI insufficient" and accepted
prompt-only.

That conclusion rested on a **false premise**: it treated "real interception" as
"build a new plugin from scratch." In fact, [ADR-010](010-autopilot-source-hosting.md)
hosts `@oh-my-matrix/autopilot`, a mature OpenClaw plugin that **already** implements:

- `before_tool_call` hook (priority 10), `index.ts:553`
- `decidePermission()` — a pure, stateless policy function (`permission-policy.ts:177`)
- a **hard gateway veto** (`block: true`), not an approval prompt (`index.ts:613-619`)
- a persisted permission audit trail (633-test suite)

The hook was gated to autopilot runs only (`findRunBySession`, `index.ts:556-557`),
so OpenProse subagent sessions — which are real OpenClaw agent sessions
(`prose/packages/co/README.md:71-83`, `openclaw/src/agents/sessions/agent-session.ts:472`) —
reached the handler but early-returned with zero enforcement.

## Decision

**Add a fail-closed `before_tool_call` branch in the autopilot plugin that
enforces `decidePermission` for every `:subagent:` session, regardless of model.**

OpenClaw subagent sessionKeys carry a `:subagent:` segment
(`openclaw/src/sessions/session-key-utils.ts:269-286`, used across ~10 modules).
The handler detects this inline (the helper is not exported via the plugin SDK)
and runs `decidePermission({ workflowAllowsDestructiveGit: false })`, which:

- **blocks** destructive_git, credential_access, system_write (hard veto);
- **allows** read_only, workspace_write, network (subagents can still do their work).

### Why this shape (Design 2) over the alternatives

- **Option A (approved plan, registry)** — "agent registers workflow sessions;
  handler checks registry." **Rejected**: registration is prompt-dependent (the
  SKILL tells the agent to call a register step), so a weak model can skip it and
  the session goes unprotected. That re-introduces the exact prompt-only bypass
  this work exists to close. The enforcement would be runtime but the *scoping*
  would be prompt-dependent.
- **Option B (extract a `workflow-guard` plugin)** — architecturally cleanest
  (dedicated guard layer, matches Claude Code PreToolUse separation) but pays
  full ADR-010 distribution ceremony for a second plugin + ~998 LOC of test
  relocation, for the same safety outcome.
- **Design 2 (chosen)** — detect subagents by sessionKey convention. Fully
  runtime, unbypassable (detection does not depend on agent cooperation),
  ~30 LOC, zero new packages, zero distribution artifacts.

### Threat model & scope

"In this stack the only active subagent orchestrator doing orchestration is
OpenProse" (MA's `sessions_spawn` is "future phases"; MA's task system is a cron
scheduler, not subagents; openclaw's task system does not itself run git). So
broadening to "all subagents" has no collateral damage today and aligns with
openclaw's existing `tools.subagents.tools` hardening philosophy
(`schema.help.ts:483`).

### Escape hatch for legitimate destructive git

A workflow that legitimately needs destructive git runs it as an **autopilot
run** with `WORKFLOW.md` `destructive_git.allow=true` — the only path that sets
`workflowAllowsDestructiveGit=true`, which also enforces workspace containment
and audit. Ad-hoc destructive git in workflow subagents is blocked.

## Consequences

**Positive:**

- Weak models can no longer bypass destructive-op safety by ignoring the SKILL
  CHECKPOINT — the gateway hard-blocks regardless of model compliance.
- Reuses the proven, 637-test `decidePermission` in place; zero policy drift.
- No new plugin, no new distribution surface.

**Negative:**

- Dynamic-workflow safety is coupled to the autopilot plugin's lifecycle: if a
  user disables autopilot, the subagent guard is also off. Code-level warning is
  **infeasible** (a disabled plugin does not load, so it cannot emit a warning);
  mitigated by documentation (`SKILL.md` names the autopilot plugin as the
  runtime-enforcement source). The `autopilot.status` gateway method can be
  queried to verify the guard is active.
- The `:subagent:` sessionKey convention is an openclaw implementation detail,
  replicated inline because it is not exported via the plugin SDK. Low risk — it
  is a stable, protocol-level convention used across ~10 openclaw modules.
- Subagent blocks are audited with a synthetic `runId: subagent:<sessionKey>` to
  distinguish them from autopilot-run entries.

## Revisit conditions

- A **third consumer** of `decidePermission` materializes (e.g. a team-orchestration
  plugin) → extract a dedicated `packages/workflow-guard/` plugin (Option B), at
  which point the distribution tax amortizes across consumers.
- A dynamic-workflow is found that **must** run destructive git in a subagent
  (cannot route through the main session or an autopilot run) → add an opt-in
  workspace-allow registry (Design 3) to lift the block for confirmed cases.

## Related ADRs

- [ADR-009](009-dynamic-workflows-via-openprose.md) — dynamic workflows via OpenProse.
- [ADR-010](010-autopilot-source-hosting.md) — hosting `@oh-my-matrix/autopilot` in omm;
  this ADR depends on that plugin already existing with `before_tool_call`.

## References

- Plan: [`.omc/plans/runtime-workflow-guard.md`](../../.omc/plans/runtime-workflow-guard.md)
  (ralplan consensus: Planner→Architect→Critic, APPROVE iteration 1)
- Implementation: `packages/autopilot/index.ts` (`isSubagentSessionKey`, `before_tool_call` handler)
- Tests: `packages/autopilot/tests/permission-wiring.test.ts` ("subagent runtime guard")
- Design reversal: `docs/design/dynamic-workflows-design.md` §11.3.3, §11.8
