# omm Architecture Overview

oh-my-matrix (omm) 是 OpenClaw 宿主的 autonomous agent runtime stack。当前架构由三个一等模块组成：

1. `@oh-my-matrix/autopilot`: 长程连续执行。
2. `dynamic-workflows` skill + `@oh-my-matrix/dynamic-workflows`: 多 agent `.prose` 编排与 subagent guard。
3. `@oh-my-matrix/permission-policy`: 共享运行时权限原语。

v0.x 的 team / MCP / plugin 实现已经移除，历史记录在 [`archive/`](archive/)。本文件只描述当前方向。

## System Shape

```mermaid
flowchart TB
  U[User goal] --> G[OpenClaw Gateway]

  G --> A[@oh-my-matrix/autopilot]
  G --> S[dynamic-workflows skill]

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
- evidence collection and validation results
- compact projection for host UI
- `WORKFLOW.md` autopilot config parsing
- token budget and tool-error controls

The plugin registers 11 OpenClaw hooks declared in `packages/autopilot/package.json`.

### Dynamic Workflows

`skill/dynamic-workflows/SKILL.md` teaches the agent to generate `.prose` programs and execute them through OpenProse. The runtime goal is high-scale parallelism with low user-context pollution: branch work happens inside workflow state, final synthesis returns to the user.

`packages/dynamic-workflows/` is the runtime guard plugin for workflow subagents. It registers `before_tool_call` at priority 11, before autopilot and audit handlers, so dangerous subagent calls are stopped at the gateway.

### Permission Policy

`packages/permission-policy/` is a pure library. It exists because autopilot and dynamic-workflows need the same command classification, permission decisions, real event extraction, and audit persistence.

The split prevents duplicated safety logic and lets future OpenClaw plugins reuse the same primitives.

## Runtime Flow

### Continuous Execution

1. User activates an autopilot run with a goal.
2. Autopilot claims workspace/run state.
3. Hooks observe agent turns, tool calls, LLM output, compaction, session lifecycle, and finalize decisions.
4. Retry/stall/evidence logic decides whether to continue, pause, resume, or complete.
5. Projection exposes compact status to the host.

### Multi-Agent Workflow

1. Agent decides the task needs workflow scale.
2. Dynamic Workflows skill generates a `.prose` program using one or more of the 8 orchestration patterns.
3. OpenProse compiles and executes the program.
4. Subagents fan out through OpenClaw sessions.
5. `@oh-my-matrix/dynamic-workflows` guards each `:subagent:` tool call.
6. Final synthesis separates verified findings from failed or uncertain branches.

## Safety Model

The model assumes workflow subagents are untrusted. They can be wrong, over-eager, or prompt-injected. Therefore:

- main session can ask for approval and make high-context decisions
- workflow subagents run under fail-closed permission defaults
- destructive git, workspace cleanup, credential access, system writes, shell substitution, and wrapper exec are blocked for subagents
- audit logs are written under `.autopilot/`

Known limitation: command parsing is tokenize-based, not a full shell parser. See [`fixes/runtime-guard-event-shape.md`](fixes/runtime-guard-event-shape.md).

## Distribution Reality

The workspace packages are private and source-hosted here. Host consumption still requires a packaging/deploy step outside this repository:

1. build affected packages
2. pack or copy dist
3. refresh the host bundled-plugin copy
4. restart the host gateway
5. run deployed-dist smoke checks

Do not claim a source change is active in MatrixAssistant/OpenClaw until that host deploy path has been verified.

## Current Gaps

- Host deploy: reproducible runbook scaffolded at [`docs/runbooks/host-deploy.md`](runbooks/host-deploy.md) — repo-side steps executable, host-internal steps marked `[TODO:host]` pending the MA team.
- README/docs now represent autopilot as first-class, but release packaging still needs a public policy.
- Permission policy needs a stronger shell model for redirect and quote-edge cases.
- Workflow observability needs a UI contract for branch graph, blocked calls, and evidence state.
