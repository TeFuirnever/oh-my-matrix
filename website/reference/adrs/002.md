# ADR-002: Team Delegation to Host Skill

## Context

oh-my-codex implements team parallelism with 20+ files: a runtime orchestrator, tmux pane management, git worktree creation, worker spawning, and state synchronization. This infrastructure is necessary because Codex CLI operates independently without access to a host orchestration layer.

OpenClaw hosts such as oh-my-claudecode already provide `TeamCreate`/`TaskCreate`/`SendMessage` primitives for parallel agent execution. Rebuilding equivalent infrastructure in omm would duplicate existing capability and create maintenance burden.

## Decision

omm-team is a **thin state-tracking bridge**（状态追踪桥接层）that delegates actual parallel execution to the host environment's team skill.

The omm-team workflow:

1. Receives task description and agent count
2. Writes tracking state (`key=team`, `current_phase=delegating`)
3. Invokes the host's team skill via `Skill()` delegation
4. Host team skill handles: `TeamCreate` → task decomposition → `TaskCreate` → workers → monitoring → `TeamDelete`
5. On completion, omm-team writes terminal state

omm-team's value is **state tracking and workflow integration** (e.g., `linked_ralph=true` for ralph↔team coordination), not parallel execution itself.

## Consequences

**Positive:**

- No duplicated parallelism infrastructure — uses battle-tested host implementation
- Minimal code: one SKILL.md vs 20+ files in oh-my-codex
- Consistent behavior: parallel execution matches what the host already provides
- Integration coordination: `linked_ralph` flag enables ralph-team handoff

**Negative:**

- Host dependency: omm-team requires a host that provides team primitives
- Less control: cannot customize worker spawning, monitoring, or cleanup
- Opaque execution: omm-team only tracks start/end, not individual worker progress

**Trade-off accepted:** omm gives up fine-grained control over parallel execution in exchange for zero-maintenance delegation to the host. If a host lacks team primitives, omm-team cannot function — this is acceptable because omm is designed for OpenClaw environments that provide these capabilities.
