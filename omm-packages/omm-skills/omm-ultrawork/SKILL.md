---
name: omm-ultrawork
description: Parallel execution engine for high-throughput task completion
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start a parallel execution session for independent work items.

## Usage

```
/omm-ultrawork <task description with parallel work items>
```

## Purpose

Ultrawork is a parallel execution protocol for independent work. It emphasizes intent grounding, parallel context gathering, dependency-aware task graphs, and concise evidence-backed execution summaries. It provides parallelism and routing guidance, but delegates team coordination to the host (per ADR-002).

## Execution Policy

- Fire all independent work simultaneously — never serialize independent tasks
- Resolve intent and uncertainty before implementation; explore first, ask only when still blocked
- For non-trivial tasks, produce a dependency-aware plan with parallel waves before execution
- Keep delegated-task reports concise: short summary, files touched, verification status, blockers
- Background long operations (builds, installs, test suites)
- Foreground quick operations (file reads, status checks)

## Lifecycle

### Phase 1: Intent Grounding

Confirm the request type:
- **Implementation**: writing or modifying code
- **Investigation**: exploring codebase or debugging
- **Evaluation**: reviewing or assessing quality
- **Research**: learning or gathering information

If unclear, ask ONE clarifying question before proceeding.

### Phase 2: Context Gathering

Gather context in parallel:
- Read relevant files directly
- Explore codebase areas related to the task
- Check existing patterns and conventions

### Phase 3: Task Decomposition

Classify work items by independence:
1. **Independent tasks** — can run in parallel
2. **Dependent tasks** — must wait for prerequisites
3. **Sequential tasks** — must run in order

For non-trivial work, create a task graph:

```
Wave 1 (parallel):
  - Task A: <description>
  - Task B: <description>

Wave 2 (depends on Wave 1):
  - Task C: <description> (needs A's output)
  - Task D: <description> (needs B's output)

Wave 3 (depends on Wave 2):
  - Task E: <final integration>
```

### Phase 4: Execution

Execute waves in order:
1. Fire all tasks in the current wave simultaneously
2. Wait for all tasks in the wave to complete
3. Verify results before advancing to the next wave
4. Repeat until all waves complete

### Phase 5: Verification

Lightweight verification when all tasks complete:
- Build/typecheck passes
- Affected tests pass
- No new errors introduced

### State

Ultrawork uses minimal state — it is a component, not a persistence mode. For persistence and resume, use ralph or autopilot (which layer on top of ultrawork patterns).

Write progress to `omm_state_write` with key `ultrawork` only if the host provides session continuity:

```json
{
  "mode": "ultrawork",
  "active": true,
  "task": "<description>",
  "waves": [
    { "wave": 1, "status": "complete", "tasks": ["A", "B"] },
    { "wave": 2, "status": "executing", "tasks": ["C", "D"] }
  ],
  "startedAt": "<ISO8601>"
}
```

## Relationship to Other Modes

- **ralph** = ultrawork + persistence + verification loops
- **autopilot** = ralph + planning + multi-step orchestration
- **team** = host-provided parallel workers + ultrawork routing
