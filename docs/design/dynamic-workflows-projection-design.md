# Design: Dynamic Workflows Projection and Observability

| | |
|---|---|
| **Status** | Accepted for fixture/TDD preparation; implementation gated |
| **Date** | 2026-07-01 |
| **Scope** | Dynamic Workflows product observability, projection contract, fixture-backed implementation plan |
| **References** | [ADR-009](../adr/009-dynamic-workflows-via-openprose.md), [ADR-012](../adr/012-dynamic-workflows-plugin-extraction.md), [ADR-013](../adr/013-permission-policy-library.md), [ADR-014](../adr/014-dynamic-workflows-product-boundary.md), [fixture capture spec](dynamic-workflows-projection-fixture-capture.md), [review report](../audits/dynamic-workflows-productization-review-2026-07-01.md) |

> 摘要:Dynamic Workflows 的底层编排能力由 OpenProse 提供,当前缺口是产品可见性。本设计定义一个只读 projection contract,从 OpenProse run state、permission-policy audit、skill/host workflow metadata 推导用户可见状态。它不引入 workflow controller,不改变 guard plugin 的安全职责,不重新实现 OpenProse runtime。

---

## 1. Background

Dynamic Workflows 当前由四层组成:

| Layer | Current owner | Current behavior |
|---|---|---|
| Workflow selection and generation | `packages/dynamic-workflows/skill/SKILL.md` | Agent 判断是否需要 workflow,生成 `.prose`,执行 OpenProse 或 direct fallback。 |
| Workflow runtime | OpenProse | 编译、执行、恢复和保存 workflow state。 |
| Runtime guard | `packages/dynamic-workflows/index.ts` + `@oh-my-matrix/permission-policy` | 只保护 `:subagent:` 工具调用,在 priority 11 的 `before_tool_call` 中 fail-closed block。 |
| Product visibility | Not implemented | Roadmap P3 要求 host 可展示 execution progress、branch outputs、blocked calls、final synthesis status。 |

ADR-009 已拒绝自建 workflow runtime。ADR-014 进一步冻结产品边界:产品化应通过 projection/observability 完成,而不是把 guard plugin 扩成 controller。

## 2. Problem

用户现在能获得的 Dynamic Workflows 产品信号太少:

- 不清楚 agent 为什么选择 workflow。
- 不清楚 `.prose` 程序在哪里、是否复用旧文件、是否经过确认。
- 不清楚 OpenProse 当前 phase 和 branch 状态。
- 不清楚哪些 branch 产出了 artifact 或失败。
- 不清楚 subagent guard 拦截了哪些 tool call。
- 不清楚 final synthesis 是 verified、partial、blocked 还是 uncertain。

这些问题会让强编排能力看起来像“只能检视问题”或“黑盒跑了一段时间后给总结”。

## 3. Goals

1. Define a stable read-only projection contract for Dynamic Workflows observability.
2. Map every projection field to a real data source.
3. Keep guard plugin behavior unchanged.
4. Support host/UI rendering of workflow progress, branch states, blocked calls, artifacts, and final synthesis status.
5. Enable fixture-backed tests before any host integration.
6. Preserve OpenProse as the only workflow runtime.

## 4. Non-Goals

- Do not build a workflow controller, scheduler, or custom JS runtime.
- Do not make `before_tool_call` decide whether a workflow should exist.
- Do not add cost, confidence, or recommendation fields until stable data sources exist.
- Do not define final visual UI layout in this document.
- Do not change permission-policy classification semantics as part of projection work.
- Do not require host deploy changes for the first projection-builder milestone.

## 5. User Jobs

Primary jobs:

1. As a user, I want to know why workflow mode was selected before it runs.
2. As a user, I want to inspect the generated or reused `.prose` artifact.
3. As a user, I want to see whether branches are pending, running, completed, failed, or blocked.
4. As a user, I want to understand blocked subagent calls without reading raw audit JSONL.
5. As a user, I want the final answer to say whether the workflow evidence is verified, partial, blocked, or uncertain.

Secondary jobs:

1. As a maintainer, I want tests that prove projection state is derived from fixtures, not invented.
2. As a host integrator, I want a compact shape that can be rendered without importing guard internals.
3. As a reviewer, I want the design to show which layer owns each field.

## 6. Architecture

### 6.1 Component View

```text
Skill / host metadata
  - workflowId
  - selectionReason
  - prosePath
  - generatedAt
  - mode
        |
        v
OpenProse run state --------------------+
  - phase                               |
  - branch status                       |
  - binding/artifact paths              |
  - execution failures                  |
                                          v
Permission-policy audit ------------> Projection builder ---> DynamicWorkflowProjection
  - blocked tool call                    ^
  - reason                               |
  - cwd                                  |
  - commandClass                         |
                                          |
Final synthesis metadata ----------------+
  - verified / partial / blocked / uncertain
  - branch evidence references
```

### 6.2 Ownership Rules

| Field category | Owner | Notes |
|---|---|---|
| Selection reason | Skill/host metadata | The guard cannot know task intent. |
| `.prose` artifact path | Skill/host metadata | Should point to `.openclaw/workflows/` or another documented workflow path. |
| Runtime phase | OpenProse run state | Projection only reads and normalizes. |
| Branch states | OpenProse run state | Branch ids and names should match runtime state where possible. |
| Blocked calls | permission-policy audit | Guard writes evidence; projection filters and groups it. |
| Final summary status | Projection builder | Derived from branch state, blocked calls, failures, and synthesis metadata. |

### 6.3 Package Placement

The first implementation should live outside the guard plugin entry path:

```text
packages/dynamic-workflows/
  src/
    projection.ts
    projection-types.ts
    projection-fixtures.ts       # test-only helper if needed
  tests/
    projection.test.ts
    fixtures/
      openprose-run-basic.json
      openprose-run-blocked.json
      permission-audit-blocked.jsonl
```

`index.ts` should not import `projection.ts` in v1. This prevents observability code from affecting `before_tool_call` runtime behavior.

Do not add a package barrel export in the first fixture/design repair. If a host later needs package exports, introduce them only after fixture-backed builder tests exist and a consumer compile test proves the import path:

```ts
export type { DynamicWorkflowProjection } from './src/projection-types';
export { buildDynamicWorkflowProjection } from './src/projection';
```

## 7. Data Sources

### 7.1 Workflow Metadata

V1 needs a metadata object because neither OpenProse state nor guard audit can explain why a workflow was selected.

```ts
interface DynamicWorkflowMetadata {
  workflowId: string;
  mode: 'openprose' | 'direct-sessions' | 'plan-only';
  selectionReason?: string;
  prosePath?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

Expected source:

- Skill/host owns metadata when generating `.prose`.
- V1 host persistence target is a sidecar near generated workflows:

  ```text
  .openclaw/workflows/<workflowId>.metadata.json
  ```

- Tests must use captured or representative fixture metadata following
  [`dynamic-workflows-projection-fixture-capture.md`](dynamic-workflows-projection-fixture-capture.md).
- The projection builder receives metadata as input. It does not discover or write this file.

### 7.2 OpenProse Run State

V1 should avoid depending on private OpenProse internals until fixtures confirm the stable shape.

Use a normalized adapter boundary:

```ts
interface NormalizedOpenProseRun {
  workflowId: string;
  phase: 'planned' | 'running' | 'completed' | 'failed';
  startedAt?: number;
  updatedAt?: number;
  branches: NormalizedWorkflowBranch[];
  artifacts: string[];
  errors: Array<{
    at?: number;
    branchId?: string;
    message: string;
  }>;
}

interface NormalizedWorkflowBranch {
  id: string;
  name?: string;
  phase: 'pending' | 'running' | 'completed' | 'failed';
  required?: boolean;
  summary?: string;
  artifacts: string[];
}
```

OpenProse-specific parsing should be isolated in an adapter:

```ts
function normalizeOpenProseRun(raw: unknown): NormalizedOpenProseRun;
```

This keeps the projection builder stable if OpenProse changes state file details.

### 7.3 Guard Audit

Guard audit evidence should be normalized from `PermissionAuditEntry`.

```ts
interface NormalizedBlockedCall {
  at: number;
  branchId?: string;
  toolName: string;
  reason: string;
  cwd?: string;
  commandClass?: string;
}
```

V1 mapping:

- Include entries with `outcome === 'block'`.
- Keep blocked calls as workflow-level evidence by default.
- Populate `branchId` only when the fixture set proves a stable mapping from audit run/session identity
  to OpenProse branch identity.
- Do not infer branch-level blocked state from `subagent:<sessionKey>` alone.
- If branch mapping is unavailable, keep `branchId` undefined instead of guessing.

### 7.4 Final Synthesis Metadata

`summaryStatus: 'verified'` requires explicit final synthesis evidence. Branch completion alone is
not enough.

```ts
interface DynamicWorkflowFinalSynthesis {
  status: 'present' | 'missing' | 'blocked';
  artifacts: string[];
  evidenceRefs: string[];
}
```

This metadata is supplied to the projection builder by the synthesis layer or host. It may refer
to final answer artifacts, OpenProse outputs, or durable synthesis notes, but it is still an input,
not something the projection builder invents.

### 7.5 Direct Session Summaries

`direct-sessions` mode is a reduced fallback. It does not use the OpenProse adapter.

```ts
interface DirectSessionSummary {
  id: string;
  name?: string;
  phase: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  summary?: string;
  artifacts: string[];
}
```

If direct-session summaries are absent, projection v1 can only show metadata, known artifacts, no
branch states, and `summaryStatus: 'uncertain'`.

## 8. Projection Contract

```ts
interface DynamicWorkflowProjection {
  workflowId: string;
  phase: 'planned' | 'running' | 'blocked' | 'completed' | 'failed';
  mode: 'openprose' | 'direct-sessions' | 'plan-only';
  selectionReason?: string;
  prosePath?: string;
  agentCount: number;
  elapsedMs: number;
  branchStates: Array<{
    id: string;
    name?: string;
    phase: 'pending' | 'running' | 'blocked' | 'completed' | 'failed';
    summary?: string;
    artifacts: string[];
  }>;
  blockedCalls: Array<{
    at: number;
    branchId?: string;
    toolName: string;
    reason: string;
    cwd?: string;
    commandClass?: string;
  }>;
  artifacts: string[];
  summaryStatus: 'verified' | 'partial' | 'blocked' | 'uncertain';
}
```

Builder input:

```ts
interface BuildDynamicWorkflowProjectionInput {
  metadata: DynamicWorkflowMetadata;
  openProseRun?: NormalizedOpenProseRun;
  directSessions?: DirectSessionSummary[];
  blockedCalls?: NormalizedBlockedCall[];
  finalSynthesis?: DynamicWorkflowFinalSynthesis;
  now?: number;
}
```

### 8.1 Field Derivation

| Field | Source | Rule |
|---|---|---|
| `workflowId` | metadata, fallback run state | Required. Throw or return invalid-result object if missing. |
| `phase` | run state + blocked calls | `blocked` if blocking prevents continuation; otherwise map runtime phase. |
| `mode` | metadata | Required for user explanation. |
| `selectionReason` | metadata | Optional but recommended. |
| `prosePath` | metadata sidecar | Optional when no `.prose` artifact exists; otherwise points to the generated or reused workflow artifact. |
| `agentCount` | run branches | Count unique branch ids. |
| `elapsedMs` | metadata/run timestamps | `now - startedAt`; 0 if not started. |
| `branchStates` | normalized run, direct session summaries, mapped blocked calls | Mark branch `blocked` only when blocked call can be mapped to that branch. |
| `blockedCalls` | audit | Preserve reason, toolName, cwd, commandClass. |
| `artifacts` | run state + metadata prosePath | De-duplicate stable paths. |
| `summaryStatus` | derived from run/session state plus final synthesis metadata | See §8.2. |

### 8.2 `summaryStatus` Rules

Use deterministic rules in this order:

1. `blocked`: required runtime or synthesis evidence proves the workflow cannot continue. Workflow-level
   blocked calls alone are not enough unless they block required continuation.
2. `partial`: at least one branch completed and at least one branch independently failed or is mapped
   to `blocked`.
3. `verified`: all required branches completed and `finalSynthesis.status === 'present'`.
4. `uncertain`: run is still pending/running, completed branches lack final synthesis metadata, branch
   mapping is insufficient, or evidence is otherwise incomplete.

V1 should not use LLM confidence scoring.

Required branches are branches with `required: true`. If no branch has that field, all OpenProse
branches are treated as required for v1.

### 8.3 Mode-Specific Semantics

| Mode | Runtime source | Projection behavior |
|---|---|---|
| `openprose` | Normalized OpenProse run state | Show run phase, branch states, artifacts, mapped blocked calls, and final synthesis status. |
| `direct-sessions` | Explicit `DirectSessionSummary[]` | Convert supplied session summaries to branch states. If absent, show metadata and artifacts only with `summaryStatus: 'uncertain'`. |
| `plan-only` | Metadata only | `phase: 'planned'`, `branchStates: []`, `summaryStatus: 'uncertain'`, artifacts may include `prosePath` or plan paths. |

## 9. Implementation Plan

### Phase 1: Fixture Contract

Create fixtures before production code, following
[`dynamic-workflows-projection-fixture-capture.md`](dynamic-workflows-projection-fixture-capture.md):

- `openprose-run-basic.json`: one fan-out run, all branches completed, one final artifact.
- `openprose-run-blocked.json`: run evidence for failed or blocked branch preconditions.
- `permission-audit-blocked.jsonl`: blocked `git reset --hard` evidence.
- `workflow-metadata-basic.json`: selection reason and `.prose` path.
- `final-synthesis-present.json`: final synthesis evidence for `summaryStatus: verified`.

Acceptance:

- Fixtures are small, readable, and checked into tests.
- Each fixture field used by projection has a comment in the test explaining its source role.
- Representative fixtures include source, capture date, redaction notes, and why a live fixture could
  not be committed.

### Phase 2: Types and Pure Builder

Implement:

```ts
function buildDynamicWorkflowProjection(input: {
  metadata: DynamicWorkflowMetadata;
  openProseRun?: NormalizedOpenProseRun;
  directSessions?: DirectSessionSummary[];
  blockedCalls?: NormalizedBlockedCall[];
  finalSynthesis?: DynamicWorkflowFinalSynthesis;
  now?: number;
}): DynamicWorkflowProjection;
```

Rules:

- Pure function.
- No filesystem reads.
- No OpenClaw API calls.
- No hook registration.
- No mutation of input objects.

### Phase 3: Adapters

Add adapters only after fixtures confirm real shapes:

```ts
function normalizeOpenProseRun(raw: unknown): NormalizedOpenProseRun;
function normalizePermissionAuditEntries(entries: PermissionAuditEntry[]): NormalizedBlockedCall[];
```

Adapters should be separately tested because raw runtime state is more likely to drift than the projection builder.

### Phase 4: Host Integration

Host integration should consume only the projection shape:

- show workflow id and mode;
- show selection reason and `.prose` path;
- show branch progress;
- show blocked-call table with reason;
- show artifacts;
- show final `summaryStatus`.

Host must not import guard internals or call `register()`.

## 10. Test Plan

### 10.1 Unit Tests

| Test | Expected |
|---|---|
| Completed run with synthesis | `phase: completed`, `summaryStatus: verified`, all required branches completed. |
| Completed run without synthesis | `summaryStatus: uncertain`. |
| Workflow-level blocked call | blocked call appears without guessed `branchId`; branch state is unchanged. |
| Branch-mapped block | branch becomes `blocked` only when mapping fixture proves the relationship; `summaryStatus: partial` if another branch completed. |
| All required continuation blocked | `phase: blocked`, `summaryStatus: blocked`. |
| Running run | `phase: running`, `summaryStatus: uncertain`. |
| Direct fallback with summaries | summaries become branch states without OpenProse adapter. |
| Direct fallback without summaries | metadata/artifacts only; `summaryStatus: uncertain`. |
| Plan-only | `phase: planned`, no branch states, `summaryStatus: uncertain`. |
| Invalid metadata | missing `workflowId` throws or returns explicit invalid result. |
| Artifact de-duplication | `.prose` path and branch artifacts appear once. |
| Purity | inputs are not mutated; builder performs no filesystem/OpenClaw/OpenProse calls. |
| Adapter drift | raw OpenProse fixture normalizes into expected run shape or fails explicitly. |

### 10.2 Guard Regression Tests

No new guard behavior is required. Existing tests remain the safety gate:

```sh
corepack pnpm --filter @oh-my-matrix/dynamic-workflows typecheck
corepack pnpm --filter @oh-my-matrix/dynamic-workflows test
```

### 10.3 Markdown/Docs Tests

For docs-only changes:

```sh
corepack pnpm exec markdownlint-cli2 \
  docs/design/dynamic-workflows-projection-design.md \
  docs/design/dynamic-workflows-projection-fixture-capture.md \
  --no-globs
```

### 10.4 Full Gate Before Runtime Export

Before exporting projection APIs from the package:

```sh
corepack pnpm --filter @oh-my-matrix/dynamic-workflows typecheck
corepack pnpm --filter @oh-my-matrix/dynamic-workflows test
corepack pnpm --filter @oh-my-matrix/permission-policy test
```

If host distribution changes, run the internal host-deploy path and deployed-dist smoke check before claiming host behavior.

## 11. Operational Notes

Use `corepack pnpm` for validation in this repository until the user-level pnpm entry is repaired. The PATH entry `/Users/guanxueliang/.local/bin/pnpm` has been observed hanging on `pnpm --version`, while `corepack pnpm` resolves the repo-declared pnpm `10.24.0` and runs the dynamic-workflows gates successfully.

The working tree may contain unrelated `.gitignore` changes for `graphify-out/`; this design does not depend on that change.

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| OpenProse run state shape is unstable | Projection adapter breaks | Keep raw-state parsing behind `normalizeOpenProseRun`; use fixture tests. |
| Branch mapping from audit to OpenProse branch is unavailable | Blocked calls cannot be attached to exact branch | Keep `branchId` optional; never guess. |
| Projection grows into controller | Violates ADR-014 | Keep builder pure and read-only; no hook registration, no runtime scheduling. |
| Host UI over-promises confidence | Misleading user trust | Use `summaryStatus` deterministic rules; avoid confidence scores in v1. |
| Tests use fictional event/run shapes | False confidence | Mark fixtures by source and update after real OpenProse state capture. |

## 13. Open Questions

- [x] Workflow metadata v1 target: skill/host sidecar at `.openclaw/workflows/<workflowId>.metadata.json`, supplied to the builder as input.
- [x] Direct-session fallback v1: reduced projection, no OpenProse adapter.
- [x] Branch mapping v1: no guessing; workflow-level blocked calls unless fixture evidence proves a branch mapping.
- [x] Package export v1: defer until fixture-backed builder tests and consumer compile test exist.
- [ ] Stable OpenProse run-state files remain gated by the fixture capture spec.

## 14. Acceptance Criteria

The design is ready for implementation when:

- ADR-014 is accepted or explicitly adopted for this workstream.
- The fixture capture spec exists and defines source, capture method, redaction, and field mapping.
- Real or representative OpenProse run-state fixtures are available before implementation starts.
- Projection tests fail before implementation and pass after implementation.
- `corepack pnpm --filter @oh-my-matrix/dynamic-workflows typecheck` passes.
- `corepack pnpm --filter @oh-my-matrix/dynamic-workflows test` passes.
- No `before_tool_call` guard behavior changes are required for projection v1.
