# omm Architecture Overview

oh-my-matrix (omm) 是 OpenClaw 宿主的 autonomous agent runtime stack。当前架构由四个一等模块组成：

1. `@oh-my-matrix/autopilot`: 长程连续执行。
2. `dynamic-workflows` skill + `@oh-my-matrix/dynamic-workflows`: 多 agent `.prose` 编排与 subagent guard。
3. `@oh-my-matrix/permission-policy`: 共享运行时权限原语。
4. `@oh-my-matrix/instinct`: 跨会话上下文记忆。

v0.x 的 team / MCP / plugin 实现已经移除，历史记录在 [`archive/`](archive/)。本文件只描述当前方向。

## System Shape

```mermaid
flowchart TB
  U[User goal] --> G[OpenClaw Gateway]

  G --> A[@oh-my-matrix/autopilot]
  G --> S[dynamic-workflows skill]
  G --> I[@oh-my-matrix/instinct]

  S --> P[OpenProse .prose runtime]
  P --> W[parallel workflow subagents]

  A --> PP[@oh-my-matrix/permission-policy]
  W --> DG[@oh-my-matrix/dynamic-workflows guard]
  DG --> PP

  PP --> AUDIT[permission audit]
  A --> E[evidence gate + projection]
  W --> R[branch results]
  E --> OUT[verified output]
  R --> OUT
```

## Module Responsibilities

### Autopilot

`packages/autopilot/` hosts `@oh-my-matrix/autopilot`, an OpenClaw-native continuous execution plugin.

It owns:

- run state: `idle` / `running` / `paused` / `done`
- orchestration state: `claimed` / `running` / `retry_queued` / `blocked` / `done`
- goal snapshot / restore
- retry queue and stall detection
- evidence collection and validation results — judging is **conditional** (verifiable tasks with validation commands only; model-level judging is deferred per [ADR-019](adr/019-conditional-evidence-judging-boundary.md))
- compact projection for host UI
- `WORKFLOW.md` autopilot config parsing
- token budget and tool-error controls

The plugin registers 12 OpenClaw hooks declared in `packages/autopilot/package.json`.

### Dynamic Workflows

`packages/dynamic-workflows/skill/SKILL.md` teaches the agent to generate `.prose` programs and execute them through OpenProse. The runtime goal is high-scale parallelism with low user-context pollution: branch work happens inside workflow state, final synthesis returns to the user.

`packages/dynamic-workflows/` is the runtime guard plugin for workflow subagents. It registers `before_tool_call` at priority 11, before autopilot and audit handlers, so dangerous subagent calls are stopped at the gateway. It also registers `agent_turn_prepare`, a deterministic task prescreen that nudges main sessions toward workflow fan-out.

It also exports a read-only **projection contract** (`buildDynamicWorkflowProjection`, `normalizeOpenProseRun`, `normalizePermissionAuditEntries`) that derives `DynamicWorkflowProjection` from real data sources — OpenProse filesystem run snapshots and guard audit entries. See [`docs/design/dynamic-workflows-projection-design.md`](design/dynamic-workflows-projection-design.md) and [ADR-014](adr/014-dynamic-workflows-product-boundary.md).

### Permission Policy

`packages/permission-policy/` is a pure library. It exists because autopilot and dynamic-workflows need the same command classification, permission decisions, real event extraction, and audit persistence.

The split prevents duplicated safety logic and lets future OpenClaw plugins reuse the same primitives.

### Instinct

`packages/instinct/` hosts `@oh-my-matrix/instinct`, a cross-session context memory plugin. Two hooks close the minimal loop: `after_tool_call` appends scrubbed `{tool, input, output}` summaries to `.instinct/observations.jsonl` (rotated, secret-scrubbed), and `session_start` injects the most recent observations for the project so a new session resumes with what the last one did. Promoting raw observations into reusable patterns (LLM distillation) is a later phase.

## Runtime Flow

### Continuous Execution

1. User activates an autopilot run with a goal.
2. Autopilot claims workspace/run state.
3. Hooks observe agent turns, tool calls, LLM output, compaction, session lifecycle, and finalize decisions.
4. Retry/stall/evidence logic decides whether to continue, pause, resume, or complete.
5. Projection exposes compact status to the host.

### Multi-Agent Workflow

1. Agent decides the task needs workflow scale.
2. Dynamic Workflows skill generates a `.prose` program using one or more of the 11 orchestration patterns.
3. OpenProse compiles and executes the program.
4. Subagents fan out through OpenClaw sessions.
5. `@oh-my-matrix/dynamic-workflows` guards each `:subagent:` tool call.
6. Final synthesis separates verified results (findings, implementations, or candidates that survived the refute gate) from failed or uncertain branches.

## Safety Model

The model assumes workflow subagents are untrusted. They can be wrong, over-eager, or prompt-injected. Therefore:

- main session can ask for approval and make high-context decisions
- workflow subagents run under fail-closed permission defaults
- destructive git, workspace cleanup, credential access, system writes, shell substitution, and wrapper exec are blocked for subagents
- audit logs are written under `.autopilot/`

Known limitation: command parsing is tokenize-based, not a full shell parser. See [`fixes/runtime-guard-event-shape.md`](fixes/runtime-guard-event-shape.md).

## Distribution Reality

The workspace packages are published to npm and consumed by hosts via the npm registry (see [ADR-010](adr/010-autopilot-source-hosting.md), [host-deploy runbook](runbooks/host-deploy.md)). `dist/` is **not committed to git** — it is regenerated from source by CI (before typecheck/test) and by `prepublishOnly` at publish time (see [ADR-015](adr/015-dist-not-committed.md)). A source change is **not** live in a consuming host until:

1. `pnpm -r test` passes in this repo (source verified),
2. the affected package is published to npm (`pnpm publish`, 2FA),
3. the host bumps its dependency version and reloads its bundled-plugin copy,
4. the host gateway is restarted, and
5. a deployed-dist smoke check passes in the host repo.

**Repo tests green ≠ host live.** Step 5 is the only proof.

## Current Gaps

- Host deploy: reproducible runbook scaffolded at [`docs/runbooks/host-deploy.md`](runbooks/host-deploy.md) — repo-side steps executable, host-internal steps marked `[TODO:host]` pending the host team.
- README/docs now represent autopilot as first-class, but release packaging still needs a public policy.
- Permission policy needs a stronger shell model for redirect and quote-edge cases.
- Workflow observability: projection contract (`DynamicWorkflowProjection`) and builder implemented (Milestone C, 2026-07-03). Host/UI rendering is partially live in MA (2026-08-18 verified: `ContinuousModeToggle.tsx` renders pauseReason/blockedReason via an exhaustive i18n map — a deliberate cross-repo compile gate; ~8 of 34 projection fields consumed). Remaining Milestone D scope: branch graph, evidence state, and newly added projection fields each need explicit MA render points + i18n map updates.
