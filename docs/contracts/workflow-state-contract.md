# Workflow State Contract（工作流状态机合同）

> Defines phase sets, transition rules, terminal states, and counter invariants for ralph, autopilot, and team modes.
>
> This contract extends the [State Contract](state-contract.md) with mode-specific rules.

## Ralph（持久化执行循环）

### Phase Set

```
init → planning → executing → verifying ↔ fixing → complete | failed
```

| Phase       | Description                                                     |
| ----------- | --------------------------------------------------------------- |
| `init`      | Initial state; write task description and parameters            |
| `planning`  | Analyze task, identify success criteria, produce execution plan |
| `executing` | Carry out the plan; write progress after each significant step  |
| `verifying` | Check all success criteria; run tests, lint, typecheck          |
| `fixing`    | Diagnose and fix verification failures; increment `fix_attempt` |
| `complete`  | All criteria met（终态：成功）                                  |
| `failed`    | Max iterations exhausted（终态：失败）                          |

### Status Field

`status` (string, lowercased)

### Counters

| Counter            | Type             | Default | Description                             |
| ------------------ | ---------------- | ------- | --------------------------------------- |
| `iteration`        | non-negative int | `0`     | Current retry iteration                 |
| `max_iterations`   | positive int     | `10`    | Maximum retry iterations before failure |
| `fix_attempt`      | non-negative int | `0`     | Fix attempts within current iteration   |
| `max_fix_attempts` | positive int     | `3`     | Max fixes before restarting iteration   |

### Retry Logic

- FIXING exceeds `max_fix_attempts` → increment `iteration`, restart from PLANNING with `lessons` carried forward
- `iteration` exceeds `max_iterations` → `status=failed`, `active=false`

### Additional Fields

| Field     | Type      | Description                                |
| --------- | --------- | ------------------------------------------ |
| `task`    | string    | Original task description                  |
| `lessons` | string[]  | Accumulated lessons from failed iterations |
| `mode`    | `"ralph"` | Mode identifier                            |

---

## Autopilot（自主执行流水线）

### Phase Set

```
analyzing → planning → executing → verifying ↔ retry → complete | blocked | failed
```

| Phase       | Description                                                   |
| ----------- | ------------------------------------------------------------- |
| `analyzing` | Explore codebase to understand current state relevant to goal |
| `planning`  | Generate numbered step list with per-step success criteria    |
| `executing` | Execute current step; write progress after each step          |
| `verifying` | End-to-end verification against original goal                 |
| `retry`     | Diagnose step failure; retry with different strategy          |
| `complete`  | Goal achieved（终态：成功）                                   |
| `blocked`   | Step exhausted retries（终态：阻塞，需人工介入）              |
| `failed`    | Unrecoverable failure（终态：失败）                           |

### Status Field

`status` (string, lowercased)

### Counters

| Counter                | Type             | Default | Description                           |
| ---------------------- | ---------------- | ------- | ------------------------------------- |
| `current_step`         | non-negative int | `0`     | Index of current step being executed  |
| `total_steps`          | non-negative int | `0`     | Total steps in plan                   |
| `max_retries_per_step` | positive int     | `3`     | Max retries before blocking on a step |

### Execution Rules

- One step at a time, sequentially
- Verify each step before advancing
- On failure, retry with a **different** strategy (never repeat the same approach)
- Retries exhausted → `status=blocked`

### Additional Fields

| Field  | Type          | Description                                         |
| ------ | ------------- | --------------------------------------------------- |
| `goal` | string        | Original goal description                           |
| `plan` | object[]      | Step list: `{ step, description, status, retries }` |
| `mode` | `"autopilot"` | Mode identifier                                     |

---

## Team（多智能体团队桥接）

### Phase Set

```
planning → decomposing → delegating → executing → verifying ↔ fixing → complete | failed
```

| Phase         | Description                                                   |
| ------------- | ------------------------------------------------------------- |
| `planning`    | Initial phase; receive task and determine agent configuration |
| `decomposing` | Break task into subtasks for parallel workers                 |
| `delegating`  | Upstream team skill is in control（已委托宿主）               |
| `executing`   | Workers are executing subtasks                                |
| `verifying`   | Verify combined results meet acceptance criteria              |
| `fixing`      | Fix verification failures; increment `fix_loop_count`         |
| `complete`    | All subtasks verified（终态：成功）                           |
| `failed`      | Max fix loops exhausted or upstream failure（终态：失败）     |

### Status Field

`current_phase` (string, lowercased) — **not** `status`

> Team uses `current_phase` instead of `status` to avoid collision with the host team skill's own status tracking.

### Counters

| Counter          | Type             | Default | Description                              |
| ---------------- | ---------------- | ------- | ---------------------------------------- |
| `fix_loop_count` | non-negative int | `0`     | Number of verify-fix cycles completed    |
| `max_fix_loops`  | positive int     | `3`     | Maximum verify-fix cycles before failure |

### Additional Fields

| Field          | Type     | Description                                                                |
| -------------- | -------- | -------------------------------------------------------------------------- |
| `task`         | string   | Original task description                                                  |
| `agent_count`  | number   | Number of parallel agents requested                                        |
| `subtasks`     | object[] | Decomposed subtask list                                                    |
| `linked_ralph` | boolean  | `true` when invoked from within ralph; ralph handles retry on team failure |
| `mode`         | `"team"` | Mode identifier                                                            |

---

## Shared Terminal Rules（共享终态规则）

Terminal phases: `complete`, `failed`, `blocked`

| Rule                                   | Enforcement                               |
| -------------------------------------- | ----------------------------------------- |
| Terminal phase + `active=true`         | **Rejected** — validation returns error   |
| Terminal phase + missing `completedAt` | **Auto-set** to current ISO8601 timestamp |
| Non-terminal phase + `active=false`    | Allowed (paused/suspended state)          |

## Timestamp Invariants（时间戳不变量）

| Field           | Auto-set When                                 | Format  |
| --------------- | --------------------------------------------- | ------- |
| `startedAt`     | `active=true` first written and field is null | ISO8601 |
| `completedAt`   | Terminal phase reached and field is null      | ISO8601 |
| `lastUpdatedAt` | Every successful write                        | ISO8601 |

## Default Injection（默认值注入）

When `active=true` and fields are null, validators inject defaults:

| Mode      | Injected Defaults                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| ralph     | `iteration=0`, `max_iterations=10`, `fix_attempt=0`, `max_fix_attempts=3`, `status="init"`, `startedAt=now` |
| autopilot | `current_step=0`, `total_steps=0`, `max_retries_per_step=3`, `status="analyzing"`, `startedAt=now`          |
| team      | `fix_loop_count=0`, `max_fix_loops=3`, `current_phase="planning"`, `startedAt=now`                          |

## Known Gap: Workflow Transition Guard（已知缺陷：工作流互斥）

Currently, multiple modes can be `active=true` simultaneously. For example, both `ralph.json` and `team.json` can have `active=true` at the same time.

**Planned fix (Phase 1):** A transition guard that checks all `*.json` files in the state directory before allowing a new `active=true` write. If another mode is already active, the write is rejected unless it's a `linked_ralph` team invocation.

See [Roadmap Phase 1](../roadmap.md) and [ADR-004](../adr/004-three-mode-state-machine.md).
