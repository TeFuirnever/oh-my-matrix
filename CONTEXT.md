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

As of plan ralplan-omm-next-best-practices (2026-05-08), the bundled set is **16 prompts** (5 starter + 11 ported from oh-my-claudecode). Ported prompts retain their omc XML structure but are stripped of Claude-only tool references (7-token strip-check enforced in CI).

**Prompt Style Coexistence Policy:**

Two styles coexist in `agent-prompts/`:

- **Lean style** (5 starter prompts): concise, ~20 lines, prose-only, OpenClaw-native design. Example: `analyst.md`.
- **XML-structured style** (11 ported prompts): ~100-200 lines with `<Role>`, `<Success_Criteria>`, `<Constraints>`, etc. blocks, retained from oh-my-claudecode for battle-tested fidelity and traceability.

Both styles parse identically through `parseAgentPrompt` (body is opaque text). Starter prompts MAY be refactored to XML structure over time if clarity benefits warrant, but ported prompts MUST NOT be rewritten to lean style without explicit approval (violates "borrow proven personas, do not rewrite them" principle).

**Agent Inventory (post-Phase-1):**

| Name | Model tier | Skill anchor | Anchor reality | Source |
|------|------------|--------------|----------------|--------|
| analyst | opus | omm-deep-interview, omm-ralplan | REAL | bundled (lean) |
| architect | opus | omm-ralplan, omm-ultraqa | REAL | bundled (lean) |
| critic | opus | omm-ralplan | REAL | bundled (lean) |
| executor | sonnet | omm-autopilot | REAL | bundled (lean) |
| verifier | sonnet | omm-autopilot, omm-ralph | REAL | bundled (lean) |
| planner | opus | omm-ralplan (Phase 1 step 1) | REAL | ported from omc (XML) |
| tracer | sonnet | omm-deep-interview | REAL | ported from omc (XML) |
| code-reviewer | opus | omm-ultraqa | REAL | ported from omc (XML) |
| security-reviewer | opus | omm-ultraqa | REAL | ported from omc (XML) |
| test-engineer | sonnet | omm-ultraqa | REAL | ported from omc (XML) |
| debugger | sonnet | omm-autopilot | REAL | ported from omc (XML) |
| qa-tester | sonnet | omm-ultraqa | REAL | ported from omc (XML) |
| explore | haiku | omm-deep-interview | REAL | ported from omc (XML) |
| document-specialist | sonnet | omm-docs (future, P1) | PLACEHOLDER | ported from omc (XML) |
| designer | sonnet | omm-ui (future, P1) | PLACEHOLDER | ported from omc (XML) |
| writer | haiku | omm-docs (future, P1) | PLACEHOLDER | ported from omc (XML) |

**Placeholder agents** (3): document-specialist, designer, writer — anchors are named future skills (omm-docs, omm-ui), not speculative. Will be activated when target skills are scheduled.

**Deferred agents** (3, NOT in this plan): git-master, scientist, code-simplifier — to be ported in a follow-up plan when omm-git, omm-research, omm-refactor skills are scheduled.

### Skill

A SKILL.md file consumed by OpenClaw's AgentSkills system. Defines a structured workflow (deep-interview, ralplan, ultrawork, ultraqa, etc.) that orchestrates agent prompts and state tools.

## Architecture Invariants

- **ADR-001**: Pure plugin, no CLI — omm is consumed via OpenClaw plugin API or MCP
- **ADR-003**: MCP servers have zero runtime dependencies (`"dependencies": {}`)
- **ADR-004**: Single validation dispatcher routes to mode-specific validators
- **ADR-005**: Cross-process locking via `omm-fs-queue.ts` for concurrent state access

## Known Trade-offs

| Trade-off | Impact | Mitigation |
|-----------|--------|------------|
| ADR-003 → MCP 代码重复 | ~200 行跨 2 个 MCP server（锁、JSON-RPC、OmmError） | 锁逻辑稳定；验证规则漂移风险通过 SKILL.md 引导 agent 使用 mode lifecycle API 缓解 |
| MCP 验证是 plugin 验证的子集 | MCP `state_write` 不注入计数器默认值、不校验时间戳格式 | mode lifecycle API 是主路径；MCP 为低级工具 |
| TRACE_SPECS 使用 `Partial` + `!` | 新增 trace event 时可能遗漏 spec | 可改为 `satisfies` 完整性检查 |
| omm 覆盖 12/26 OpenClaw hooks | 可能遗漏有用的生命周期事件 | 按需添加，当前无功能缺失 |
| manifest `apiVersion` 作用不确定 | 未来 OpenClaw 版本可能读取此字段 | 监控 OpenClaw changelog |
| 11 ported agent prompts 是 point-in-time snapshots | 与 oh-my-claudecode 上游 agent prompts 可能漂移 | resync policy 是 owner-driven，不是自动化；7-token strip-check 在 CI 中防止 Claude-only token 回流 |
| 3 PLACEHOLDER agents 无当前 skill 消费者 | document-specialist, designer, writer 等待 omm-docs / omm-ui 被调度 | inventory 表显式标注 PLACEHOLDER，待 target skill 落地后转为 REAL |
