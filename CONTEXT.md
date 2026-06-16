# CONTEXT.md — oh-my-matrix Domain Language

> Single-context repo. All domain vocabulary lives here.

## Core Concepts

### Workflow Mode

`team` — the **sole** workflow mode. Coordinated parallel agents with a shared plan. Tracks `fix_loop_count` for convergence. At most one `team` may be active at a time (enforced by the workflow exclusivity guard in `omm-workflow-guard.ts`).

> **History (2026-06-16):** omm previously supported three modes (`ralph`, `autopilot`, `team`). `ralph` and `autopilot` were **deleted and delegated to the host** (MA's `@openclaw/autopilot` plugin), which covers autonomous-loop and goal capabilities more maturely. See [ADR-008](docs/adr/008-delegation-to-host.md) and [ADR-002](docs/adr/002-team-delegation-to-host.md) for the delegation principle. omm now focuses on `team` orchestration + the digital-employee bridge.

### Phase

A `team`-mode lifecycle step (see `omm-state-validation.ts`):

| Mode | Phases | Field |
|------|--------|-------|
| team | planning, decomposing, delegating, executing, synthesizing, verifying, fixing, complete, failed, blocked | `current_phase` |

Terminal phases (`complete`, `failed`, `blocked`) require `active=false` and auto-set `completedAt`.

### State

A JSON file (`{mode}.json`) in `{stateRoot}/state/`. Validated on write via `validateStateWrite`. The lifecycle API (`startMode`, `updateModeState`, `cancelMode`) is the preferred interface.

### Counter

`team`-mode numeric fields injected with defaults on `active=true`:

| Mode | Counters |
|------|----------|
| team | `fix_loop_count` (0), `max_fix_loops` (3) |

### Trace

Per-session event log (`{stateRoot}/trace/{sessionId}.jsonl`). Records `before_tool_call`, `after_tool_call`, `llm_input`, `llm_output`, and `agent_end` events automatically via OpenClaw hooks.

### Hook

An event emitted by OpenClaw runtime (`session_start`, `before_tool_call`, etc.). omm registers 14 hooks that dispatch to user-supplied modules in `{stateRoot}/hooks/{event}/` and optionally append trace records.

### RunOutcome

Terminal record stamped on a state when a mode ends. Discriminated by `kind`: `completed`, `failed`, `blocked`, or `cancelled`. Stored in the state's `outcome` field.

### Agent Prompt

A markdown file (`agent-prompts/{name}.md`) providing a specialized persona (analyst, architect, critic, executor, verifier). Accessible via MCP Prompts catalog (`omm-mcp` `prompts/get`); agent prompts are no longer exposed as plugin tools as of v0.5.0.

As of the P2 prompt parity pass (2026-05-13), the bundled set is **19 prompts** (5 starter + 14 ported from oh-my-claudecode). Ported prompts retain their omc XML structure but are stripped of Claude-only tool references (7-token strip-check enforced in CI).

**Prompt Style Coexistence Policy:**

Two styles coexist in `agent-prompts/`:

- **Lean style** (5 starter prompts): concise, ~20 lines, prose-only, OpenClaw-native design. Example: `analyst.md`.
- **XML-structured style** (14 ported prompts): ~100-200 lines with `<Role>`, `<Success_Criteria>`, `<Constraints>`, etc. blocks, retained from oh-my-claudecode for battle-tested fidelity and traceability.

Both styles parse identically through `parseAgentPrompt` (body is opaque text). Starter prompts MAY be refactored to XML structure over time if clarity benefits warrant, but ported prompts MUST NOT be rewritten to lean style without explicit approval (violates "borrow proven personas, do not rewrite them" principle).

**Agent Inventory:**

> Agent prompts are a **persona library consumed by `omm-team` orchestration** (accessible via MCP Prompts catalog). With only `omm-team` shipped ([ADR-008](docs/adr/008-delegation-to-host.md)), agents no longer carry per-skill anchors — every persona is available for team delegation. Autonomous-loop and artifact-pipeline skills that previously anchored these personas were removed; autonomous execution is delegated to the host's `@openclaw/autopilot`.

| Name | Model tier | Source |
|------|------------|--------|
| analyst | opus | bundled (lean) |
| architect | opus | bundled (lean) |
| critic | opus | bundled (lean) |
| executor | sonnet | bundled (lean) |
| verifier | sonnet | bundled (lean) |
| planner | opus | ported from omc (XML) |
| tracer | sonnet | ported from omc (XML) |
| code-reviewer | opus | ported from omc (XML) |
| security-reviewer | opus | ported from omc (XML) |
| test-engineer | sonnet | ported from omc (XML) |
| debugger | sonnet | ported from omc (XML) |
| qa-tester | sonnet | ported from omc (XML) |
| explore | haiku | ported from omc (XML) |
| document-specialist | sonnet | ported from omc (XML) |
| designer | sonnet | ported from omc (XML) |
| writer | haiku | ported from omc (XML) |
| git-master | sonnet | ported from omc (XML) |
| scientist | sonnet | ported from omc (XML) |
| code-simplifier | opus | ported from omc (XML) |

### Skill

A SKILL.md file consumed by OpenClaw's AgentSkills system. omm ships a single workflow skill: **`omm-team`** (multi-agent team orchestration with the MA digital-employee bridge). All other skills (ralph, autopilot, ralplan, deep-interview, ultrawork, ultraqa, docs, ui, git, research, refactor) were removed — autonomous execution is delegated to the host's `@openclaw/autopilot` ([ADR-008](docs/adr/008-delegation-to-host.md)). `omm-team` follows the **Lifecycle Conventions** in `docs/contracts/skill-lifecycle.md` §1.

## Architecture Invariants

- **ADR-001**: Pure plugin, no CLI — omm is consumed via OpenClaw plugin API or MCP
- **ADR-003**: MCP servers have zero runtime dependencies (`"dependencies": {}`)
- **ADR-004**: Single validation dispatcher routes to mode-specific validators
- **ADR-005**: Cross-process locking via `omm-fs-queue.ts` for concurrent state access
- **MCP capability matrix (v0.5)**: only `omm-mcp` ships — it advertises `tools` + `resources` (state) + `prompts` (agent prompts). Resources are read-only; mutations go through tools. (`omm-mcp-memory` / `omm-mcp-trace` were removed in v0.5 as non-essential.) Full URI scheme + contract documented in `docs/contracts/mcp.md`.

## Known Trade-offs

| Trade-off | Impact | Mitigation |
|-----------|--------|------------|
| ADR-003 → MCP 代码重复 | ~200 行跨 2 个 MCP server（锁、JSON-RPC、OmmError） | 锁逻辑稳定；验证规则漂移风险通过 SKILL.md 引导 agent 使用 mode lifecycle API 缓解 |
| ADR-006 → MCP 内联构建时代码生成 | 构建时从 omm-plugin/src/ 读取规范源文件并注入到 MCP 服务器 | 单一源真理；零运行时依赖（代码在构建时打包） |
| MCP 验证是 plugin 验证的子集 | MCP `state_write` 不注入计数器默认值、不校验时间戳格式 | mode lifecycle API 是主路径；MCP 为低级工具 |
| TRACE_SPECS 使用 `Partial` + `!` | 新增 trace event 时可能遗漏 spec | 可改为 `satisfies` 完整性检查 |
| omm 覆盖 14/26 OpenClaw hooks | 可能遗漏有用的生命周期事件 | 按需添加，当前无功能缺失 |
| manifest `apiVersion` 作用不确定 | 未来 OpenClaw 版本可能读取此字段 | 监控 OpenClaw changelog |
| 14 ported agent prompts 是 point-in-time snapshots | 与 oh-my-claudecode 上游 agent prompts 可能漂移 | resync policy 是 owner-driven，不是自动化；7-token strip-check 在 CI 中防止 Claude-only token 回流 |
| 0 PLACEHOLDER agents — all P0/P1 anchors resolved | n/a (cleared by omm-docs + omm-ui landings) | n/a |
