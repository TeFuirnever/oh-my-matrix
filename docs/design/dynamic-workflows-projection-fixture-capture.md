# Design: Dynamic Workflows Projection Fixture Capture

| | |
|---|---|
| **Status** | Required before projection implementation |
| **Date** | 2026-07-01 |
| **Scope** | Fixture sources, capture rules, redaction, and projection field mapping for Dynamic Workflows observability |
| **References** | [ADR-014](../adr/014-dynamic-workflows-product-boundary.md), [projection design](dynamic-workflows-projection-design.md), [review report](../audits/dynamic-workflows-productization-review-2026-07-01.md) |

This document is the capture contract for the future projection builder. It exists to prevent projection tests from passing against invented OpenProse or audit shapes.

## 1. Capture Principles

1. Every committed fixture must be captured from, or explicitly derived from, a real source surface.
2. A representative fixture is allowed only when it includes `representativeSource`, `captureDate`, and the reason a live capture could not be committed.
3. Fixture comments belong in nearby test code or fixture README files, not inside JSON.
4. Projection builder tests may read fixtures, but the builder itself must remain pure: no filesystem reads, OpenClaw calls, OpenProse calls, or mutation of inputs.
5. Branch-level blocked mapping is disabled unless a fixture proves a stable mapping from guard audit session identity to OpenProse branch identity.

## 2. Required Fixture Set

| Fixture | Required before | Source | Projection fields supported |
|---|---|---|---|
| `workflow-metadata-basic.json` | Builder happy path tests | Skill/host metadata sidecar | `workflowId`, `mode`, `selectionReason`, `prosePath`, timestamps |
| `openprose-run-basic.json` | OpenProse adapter tests | Captured OpenProse run state | `phase`, `branchStates`, branch artifacts, run artifacts |
| `openprose-run-blocked.json` | Branch/failure adapter tests | Captured or representative OpenProse run state with incomplete or failed branch evidence | branch `failed` or `blocked` preconditions |
| `permission-audit-blocked.jsonl` | Guard audit normalization tests | permission-policy audit JSONL | `blockedCalls`, reason, cwd, command class |
| `final-synthesis-present.json` | `summaryStatus` tests | Final synthesis metadata sidecar | `summaryStatus: verified` eligibility, synthesis artifacts |

These are minimum fixtures. Additional fixtures may be added for malformed input and direct fallback tests.

## 3. Workflow Metadata Sidecar

V1 metadata is owned by the skill/host boundary, not by the guard plugin and not by OpenProse internals.

Recommended committed fixture path:

```text
packages/dynamic-workflows/tests/fixtures/projection/workflow-metadata-basic.json
```

Recommended runtime sidecar path for host integration:

```text
.openclaw/workflows/<workflowId>.metadata.json
```

Required fields:

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

The projection builder receives this object as input. It does not discover the sidecar path by reading the filesystem.

## 4. OpenProse Run Fixtures

OpenProse run fixtures must be captured from the durable state written by an actual `.prose` run. The adapter test should record the exact capture source in a fixture README or test comment.

Expected capture evidence:

```text
source: OpenProse run state
workflowId: <stable fixture id>
prosePath: .openclaw/workflows/<workflowId>.prose
statePath: <actual OpenProse state file or directory used by the adapter>
captureDate: 2026-07-01 or later
```

The adapter normalizes raw OpenProse state into:

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
```

If the raw OpenProse state does not expose a stable branch identifier, the fixture must preserve the raw evidence and the adapter must create only deterministic local ids. It must not claim guard audit branch mapping.

## 5. Permission Audit Fixture

`permission-audit-blocked.jsonl` comes from the permission-policy audit stream produced by the runtime guard.

Expected committed path:

```text
packages/dynamic-workflows/tests/fixtures/projection/permission-audit-blocked.jsonl
```

Required retained fields:

| Audit field | Projection use |
|---|---|
| `at` or timestamp equivalent | `blockedCalls[].at` |
| tool name | `blockedCalls[].toolName` |
| `outcome: "block"` | inclusion filter |
| reason | `blockedCalls[].reason` |
| cwd | `blockedCalls[].cwd` |
| command class | `blockedCalls[].commandClass` |
| run or session id | optional branch mapping evidence only |

Audit entries that cannot be mapped to a branch stay workflow-level:

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

`branchId` is populated only when the same fixture set proves the mapping from audit run/session identity to OpenProse branch identity.

## 6. Final Synthesis Fixture

`verified` requires explicit final synthesis evidence. Completed branches alone produce `uncertain`.

Recommended fixture:

```text
packages/dynamic-workflows/tests/fixtures/projection/final-synthesis-present.json
```

Shape:

```ts
interface DynamicWorkflowFinalSynthesis {
  status: 'present' | 'missing' | 'blocked';
  artifacts: string[];
  evidenceRefs: string[];
}
```

Rules:

- `status: 'present'` plus all required branches completed is required for `summaryStatus: 'verified'`.
- `status: 'missing'` prevents `verified`.
- `status: 'blocked'` may produce `blocked` only when run or audit evidence shows the synthesis step could not continue.

## 7. Direct Fallback Fixtures

`direct-sessions` is not OpenProse. Its fixtures must use explicitly supplied session summaries instead of the OpenProse adapter.

Recommended shape:

```ts
interface DirectSessionSummary {
  id: string;
  name?: string;
  phase: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  summary?: string;
  artifacts: string[];
}
```

If no direct-session summaries are supplied, the reduced projection contains metadata, known artifacts, no branch states, and `summaryStatus: 'uncertain'`.

## 8. Plan-Only Fixture

`plan-only` has no runtime branch state.

Expected projection:

- `phase: 'planned'`
- `branchStates: []`
- `summaryStatus: 'uncertain'`
- `artifacts` may include `prosePath` or plan artifact paths from metadata.

## 9. Redaction Rules

Before committing fixtures:

1. Replace absolute user home paths with stable repo-relative or placeholder paths.
2. Remove tokens, credentials, API keys, cookies, and private prompt text.
3. Preserve safety-relevant command class, tool name, cwd shape, outcome, reason, and timestamps when they are needed by tests.
4. Keep enough raw structure for adapter drift tests to fail when upstream shapes change.
5. Record every redaction class in the fixture README or test comment.

## 10. Implementation Gate

Projection implementation may start only after:

- the required fixture set exists;
- each fixture has source, capture path, capture date, and redaction notes;
- branch mapping fixtures either prove stable mapping or explicitly leave blocked calls workflow-level;
- tests are written to fail first for happy path, missing synthesis, branch mapping negative, direct fallback, plan-only, invalid input, and purity.
