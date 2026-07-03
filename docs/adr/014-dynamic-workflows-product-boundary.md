# ADR-014: Dynamic Workflows Product Boundary

## Status

Accepted for the Dynamic Workflows projection workstream (2026-07-01).

This accepts the product boundary and fixture-first projection direction only. It does not
accept a runtime implementation, host UI design, package export, or any guard behavior change.

## Context

`@oh-my-matrix/dynamic-workflows` currently spans two different surfaces:

- `packages/dynamic-workflows/skill/SKILL.md` teaches agents to generate `.prose`
  workflow programs and execute them through OpenProse.
- `packages/dynamic-workflows/index.ts` is an OpenClaw runtime guard plugin that
  registers `before_tool_call` priority 11 and blocks unsafe `:subagent:` tool calls.

ADR-009 already decided that dynamic workflow execution should use OpenProse instead of
a custom omm runtime. ADR-012 extracted the workflow subagent guard into its own plugin,
and ADR-013 moved the shared permission primitives into the neutral
`@oh-my-matrix/permission-policy` library.

A 2026-07-01 productization review found that the bottom-layer workflow capability is
not the limiting factor: OpenProse covers the required orchestration patterns. The product
gap is visibility and explanation. Users cannot yet reliably see why a workflow was chosen,
which branches ran, which calls were blocked, what evidence each branch produced, or whether
the final synthesis is verified, partial, blocked, or uncertain.

The rejected plan was to make `@oh-my-matrix/dynamic-workflows` a central workflow
controller. That plan mixed four boundaries:

1. agent/skill workflow selection,
2. OpenProse execution,
3. runtime safety guard hooks,
4. host/UI observability projection.

That would risk reintroducing a custom runtime layer under a different name and would make
the `before_tool_call` hook responsible for planning semantics it cannot observe.

## Decision

Productize Dynamic Workflows through an observability/projection contract, not by turning
the guard plugin into a workflow controller.

The layer boundaries are:

| Layer | Owner | Responsibility |
|---|---|---|
| Workflow selection and generation | `packages/dynamic-workflows/skill/SKILL.md` and host/agent prompt surface | Decide whether workflow scale is justified, generate `.prose`, and record workflow metadata. |
| Workflow execution | OpenProse | Compile, execute, resume, and persist workflow state. |
| Runtime safety | `@oh-my-matrix/dynamic-workflows` plugin + `@oh-my-matrix/permission-policy` | Fail-closed guard for `:subagent:` tool calls and append blocked-call audit evidence. |
| Product visibility | host/UI projection layer | Read OpenProse run state plus guard audit evidence and render branch progress, blocked calls, artifacts, and final synthesis state. |

The minimum projection should be read-only and derived from real data sources:

```ts
interface DynamicWorkflowProjection {
  workflowId: string;
  phase: 'planned' | 'running' | 'blocked' | 'completed' | 'failed';
  agentCount: number;
  elapsedMs: number;
  branchStates: Array<{
    id: string;
    name?: string;
    phase: 'pending' | 'running' | 'blocked' | 'completed' | 'failed';
    summary?: string;
    artifacts?: string[];
  }>;
  blockedCalls: Array<{
    at: number;
    branchId?: string;
    toolName: string;
    reason: string;
    cwd?: string;
  }>;
  artifacts: string[];
  summaryStatus: 'verified' | 'partial' | 'blocked' | 'uncertain';
}
```

The projection's authoritative inputs are:

- OpenProse run state for workflow phase, branch state, branch outputs, artifacts, and
  execution failure state.
- `@oh-my-matrix/permission-policy` audit entries for blocked tool calls.
- skill/host workflow metadata sidecar data for the reason a workflow was selected and the
  path of the generated `.prose` artifact.

For the v1 workstream, metadata is represented as an explicit input and may be persisted near
the generated workflow as:

```text
.openclaw/workflows/<workflowId>.metadata.json
```

The projection builder may consume that object when provided, but must not perform filesystem
discovery or mutate runtime state.

## Non-Decisions

This ADR does not define the final host UI layout.

This ADR does not introduce a new workflow scheduler, custom JS runtime, or replacement for
OpenProse.

This ADR does not add a `workflow controller` tool or make `before_tool_call` responsible
for workflow planning.

This ADR does not authorize exporting projection APIs from `@oh-my-matrix/dynamic-workflows`.
Package exports should wait until fixture-backed builder tests and a consumer compile check exist.

This ADR does not commit to cost, confidence, or recommendation fields. Those fields require
stable data sources and should remain out of the v1 projection unless they can be verified.

## Rationale

1. **Preserves ADR-009.** OpenProse remains the execution runtime, so omm does not rebuild
   scheduling, recursion, branching, or run persistence.
2. **Keeps hooks deterministic.** The guard hook sees tool calls, not full task intent.
   It should enforce and audit, not decide product strategy.
3. **Matches the actual product gap.** The missing capability is observability: branch graph,
   blocked-call reporting, artifacts, and synthesis status.
4. **Avoids invented state.** Projection fields must map to OpenProse run state, guard audit,
   or skill/host metadata. Anything else is deferred.
5. **Protects testability.** Guard tests stay about safety; projection tests can use fixture
   run state and audit entries without changing runtime behavior.

## Consequences

**Positive:**

- The `dynamic-workflows` runtime package remains small and safety-focused.
- Product work can proceed through a narrow, testable projection builder.
- Host/UI can explain large fan-out workflows without coupling to guard internals.
- Future workflow metadata has a clear owner instead of being inferred from tool calls.

**Negative:**

- Productization requires host/UI work, not just package-local plugin changes.
- The first useful milestone is a data contract and fixtures, which is less visible than
  adding a new controller command.
- OpenProse run-state details must be confirmed before finalizing field names and source
  mappings.

## Verification Plan

Before implementation:

1. Use `corepack pnpm` for repository validation. The user-level
   `/Users/guanxueliang/.local/bin/pnpm` entry currently hangs before printing
   `--version`, while `corepack pnpm` resolves the repo-declared pnpm 10.24.0 and
   successfully runs the dynamic-workflows gates.
2. Follow the fixture capture contract in
   [`docs/design/dynamic-workflows-projection-fixture-capture.md`](../design/dynamic-workflows-projection-fixture-capture.md).
3. Capture representative OpenProse run-state fixtures.
4. Capture representative guard audit entries, including blocked subagent calls.
5. Capture final synthesis metadata so `summaryStatus: "verified"` is not inferred from branch
   completion alone.

For implementation:

1. Add projection tests that derive `phase`, `branchStates`, `blockedCalls`, and
   `summaryStatus` from fixtures.
2. Keep existing guard tests focused on `:subagent:` enforcement and audit.
3. If host distribution changes, run the internal host-deploy path and deployed-dist smoke
   check before claiming the host sees the new behavior.

## Follow-ups

- Keep the projection contract section in `docs/roadmap.md` P3 aligned with this ADR.
- Design fixture-backed tests for the projection builder.
- Repair or replace the user-level pnpm entry outside the projection workstream; keep
  using `corepack pnpm` for repo gates until then.
- Implement the projection builder only after the data source mapping is confirmed.

## Related

- [ADR-009: Dynamic Workflows via OpenProse](009-dynamic-workflows-via-openprose.md)
- [ADR-012: Extract `dynamic-workflows` as a Second omm Plugin](012-dynamic-workflows-plugin-extraction.md)
- [ADR-013: Extract `@oh-my-matrix/permission-policy` as a Neutral Library](013-permission-policy-library.md)
- [Dynamic Workflows 产品化计划对抗 Review 报告](../audits/dynamic-workflows-productization-review-2026-07-01.md)
- [Design: Dynamic Workflows Projection and Observability](../design/dynamic-workflows-projection-design.md)
