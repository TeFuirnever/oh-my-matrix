# CONTEXT.md — oh-my-matrix Domain Language

> Single-context repo. All domain vocabulary lives here.

## Core Concepts

### Workflow Mode

One of `ralph`, `autopilot`, or `team`. Exactly one may be active at a time (enforced by the workflow exclusivity guard in `omm-workflow-guard.ts`).

- **ralph** — Sequential iteration loop: plan → execute → verify → fix → repeat. Terminates when all acceptance criteria pass or `max_iterations` exhausted.
- **autopilot** — Autonomous pipeline: analyze → plan → execute (parallel) → QA cycle → validate. Advances through a `Stage[]` plan.
- **team** — Coordinated parallel agents with a shared plan. Tracks `fix_loop_count` for convergence.

### Phase

A mode-specific lifecycle step. Each mode defines its own set (see `omm-state-validation.ts`):

| Mode | Phases | Field |
|------|--------|-------|
| ralph | init, planning, executing, verifying, fixing, complete, failed | `status` |
| autopilot | analyzing, planning, executing, verifying, retry, complete, blocked, failed | `status` |
| team | planning, decomposing, executing, verifying, fixing, delegating, complete, failed | `current_phase` |

Terminal phases (`complete`, `failed`, `blocked`) require `active=false` and auto-set `completedAt`.

### State

A JSON file (`{mode}.json`) in `{stateRoot}/state/`. Validated on write via `validateStateWrite`. The lifecycle API (`startMode`, `updateModeState`, `cancelMode`) is the preferred interface.

### Counter

Mode-specific numeric fields injected with defaults on `active=true`:

| Mode | Counters |
|------|----------|
| ralph | `iteration` (0), `max_iterations` (10), `fix_attempt` (0), `max_fix_attempts` (3) |
| autopilot | `current_step` (0), `total_steps` (0), `max_retries_per_step` (3) |
| team | `fix_loop_count` (0), `max_fix_loops` (3) |

### Trace

Per-session event log (`{stateRoot}/trace/{sessionId}.jsonl`). Records `before_tool_call`, `after_tool_call`, `llm_input`, `llm_output`, and `agent_end` events automatically via OpenClaw hooks.

### Hook

An event emitted by OpenClaw runtime (`session_start`, `before_tool_call`, etc.). omm registers 12 hooks that dispatch to user-supplied modules in `{stateRoot}/hooks/{event}/` and optionally append trace records.

### RunOutcome

Terminal record stamped on a state when a mode ends. Discriminated by `kind`: `completed`, `failed`, `blocked`, or `cancelled`. Stored in the state's `outcome` field.

### Agent Prompt

A markdown file (`agent-prompts/{name}.md`) providing a specialized persona (analyst, architect, critic, executor, verifier). Loaded by `omm_agent_prompt_get` for SKILL.md orchestration.

### Skill

A SKILL.md file consumed by OpenClaw's AgentSkills system. Defines a structured workflow (deep-interview, ralplan, ultrawork, ultraqa, etc.) that orchestrates agent prompts and state tools.

## Architecture Invariants

- **ADR-001**: Pure plugin, no CLI — omm is consumed via OpenClaw plugin API or MCP
- **ADR-003**: MCP servers have zero runtime dependencies (`"dependencies": {}`)
- **ADR-004**: Single validation dispatcher routes to mode-specific validators
- **ADR-005**: Cross-process locking via `omm-fs-queue.ts` for concurrent state access
