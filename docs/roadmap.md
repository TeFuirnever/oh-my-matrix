# omm Development Roadmap

> Current: v0.5.0 — Phase 1–4 automated release surface shipped; MA integration testing in progress.
>
> **2026-06-16 update ([ADR-008](adr/008-delegation-to-host.md)):** ralph / autopilot / goal deleted and delegated to the host's `@openclaw/autopilot` plugin; omm converged to single-mode `team`. The Phase 1–4 records below are historical.

## Current State Summary

omm ships the core workflow engine and consumer integration helpers:

- **6 tools** registered via OpenClaw Plugin ABI (incl. MA employee-bridge: list/dispatch/result/result_batch)
- **1 packaged skill** (core: team) — all other skills removed (ralph/autopilot/goal delegated to host `@openclaw/autopilot`; ping/cancel removed as non-essential; artifact skills deleted per [ADR-008](adr/008-delegation-to-host.md))
- **1 MCP server** for state access (omm-mcp; memory and trace removed as non-essential)
- **State validation** for the team mode (single-mode, post-ADR-008) with `synthesizing` phase and `subtasks` schema (v0.5)
- **264 tests** passing, CI pipeline operational
- **Compliance and consumer-seed toolchain** (scan-names, generate/verify inlines, verify-bundle, verify-provenance, smoke-mcp, MA/OpenClaw seeders)

See [Architecture Overview](architecture.md) for module details.

---

## Phase 1: Workflow Runtime（工作流运行时）

**Goal:** Make ralph/autopilot/team workflows production-usable with persistence, mutual exclusion, and pipeline orchestration.

**Priority:** High — blocks workflow usability

| Deliverable                           | Description                                                                                                    | Reference                                      | Status              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------- |
| Workflow transition guard（互斥守卫） | Enforce single active workflow mode at a time; reject `active=true` writes when another mode is already active | oh-my-codex `workflow-transition-reconcile.ts` | ✓ Done (2026-04-26) |
| Ralph persistence                     | Progress ledger（进度账本）and PRD management; enable resume across sessions                                   | oh-my-codex `ralph/persistence.ts`             | ✓ Done (2026-04-26) |
| Pipeline stage definitions            | Define autopilot stage sequence (analyze → plan → execute → verify); enable structured multi-step execution    | oh-my-codex `pipeline/orchestrator.ts`         | ✓ Done (2026-04-26) |

**Exit criteria:**

- [x] Only one of ralph/autopilot/team can be `active=true` at any time
- [x] Ralph can resume from persisted state after session restart
- [x] Autopilot executes a multi-step plan with per-step verification
- [x] All existing tests continue to pass + new tests for transition guard

**Estimated scope:** ~5-8 new files, ~500-800 lines

---

## Phase 2: Extended MCP（扩展 MCP 服务器）

**Goal:** Add memory and trace MCP servers for richer workflow context.

**Priority:** Medium — enhances workflow quality but not blocking

| Deliverable       | Description                                                                  | Reference              | Status              |
| ----------------- | ---------------------------------------------------------------------------- | ---------------------- | ------------------- |
| Memory MCP server | Persistent key-value memory store（持久化记忆存储）for cross-session context | oh-my-codex memory MCP | ✓ Done (2026-04-26) |
| Trace MCP server  | Execution trace recording and querying（执行轨迹记录）                       | oh-my-codex trace MCP  | ✓ Done (2026-04-26) |

**Exit criteria:**

- [x] Memory MCP: read/write/list/delete operations over stdio
- [x] Trace MCP: record execution events, query by session/time range
- [x] Both servers follow zero-dependency pattern ([ADR-003](adr/003-zero-dependency-mcp.md))
- [x] Consumer integration updated (seed config, bundle manifest)

**Estimated scope:** ~4-6 new files, ~400-600 lines

---

## Phase 3: Polish and Extensibility（完善与扩展性）

**Goal:** Improve developer experience, add extensibility hooks, expand test coverage.

**Priority:** Low — quality-of-life improvements

| Deliverable            | Description                                                    | Reference                          | Status                                                                                                |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Hook plugin system     | Dynamic hook loading from `.omm/hooks/*.mjs`（动态钩子加载）   | oh-my-codex hook loader/dispatcher | ✓ Done (2026-04-26)                                                                                   |
| Agent prompt library   | Reusable role prompts (planner, architect, executor, verifier) | oh-my-codex 33 agent prompt files  | ✓ Done (2026-04-26)                                                                                   |
| Expanded test coverage | Integration tests, MCP server tests, edge case coverage        | Target 80%+ coverage               | ✓ Done (2026-04-26) — 96.83% statements / 98.27% functions / 91.07% branches via `pnpm test:coverage` |

**Exit criteria:**

- [x] Custom hooks can be loaded and dispatched at session lifecycle points
- [x] At least 5 agent prompts available for common workflow roles
- [x] Test coverage ≥ 80% across all packages

---

## Phase 4: Agent Library Expansion + MCP Capability Surface（智能体库扩展与 MCP 能力面）

**Goal:** Broaden agent persona coverage to match the core development lifecycle, and expose richer omm telemetry through standard MCP channels (Resources, Prompts, Progress) for downstream UI consumers (MatrixAssistant).

**Priority:** Medium — unlocks UI integration and lifecycle coverage

| Deliverable                          | Description                                                                                  | Reference                                            | Status                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Agent prompt expansion (P0+P1)       | Port 11 oh-my-claudecode agents covering planning, tracing, review, debugging, exploration   | `oh-my-claudecode/agents/`                           | ✓ Done (2026-05-08) — 16 total agents (5 starter + 11 ported) |
| 7-token strip-check in CI            | Prevent Claude-only semantic tokens from leaking into ported prompts                         | `omm-agent-prompts.test.ts`                          | ✓ Done (2026-05-08) — 376/376 tests pass                     |
| MCP capability survey                | Determine which MCP capabilities (Resources/Prompts/Progress) the OpenClaw + MA stack supports | `docs/research/mcp-capability-survey.md`             | ✓ Done (2026-05-08) — R1 recommended                         |
| MCP Resources advertisement          | Upgrade omm-mcp + omm-mcp-trace to advertise `resources/list` + `resources/read`              | `docs/research/mcp-capability-survey.md` §4 R1 sketch | ✓ Done (2026-05-08) — `omm://state/<key>` + `omm://trace/<sessionId>` |
| MCP Prompts advertisement            | Expose agent prompts via `prompts/list` + `prompts/get`                                      | MCP spec 2025-06-18                                  | ✓ Done (2026-05-08) — `omm://prompts/<name>`                          |
| Progress notifications verification  | Confirm whether MA client routes `notifications/progress`                                    | follow-up research                                   | ✓ Done (2026-05-08) — DEFER (MA self-audit P6 marks unsupported; see `docs/research/mcp-progress-notification-survey.md`) |
| omm-docs skill                       | Documentation generation pipeline (research → draft → verify); activates writer + document-specialist | omm-skills new entry                          | ✓ Done (2026-05-08) — `omm-packages/omm-skills/omm-docs/SKILL.md`; bundled by suite builder |
| omm-ui skill                         | UI artifact generation pipeline (discover → generate → verify); activates designer; produces components / specs / theme tokens | omm-skills new entry                  | ✓ Done (2026-05-08) — `omm-packages/omm-skills/omm-ui/SKILL.md`; bundled by suite builder |
| P2 agent porting                     | Port git-master, scientist, code-simplifier with target skill anchors                        | `oh-my-claudecode/agents/`                           | ✓ Done (2026-05-13) — 19 total agents (5 starter + 14 ported); `omm-git`, `omm-research`, `omm-refactor` |

**Exit criteria:**

- [x] Agent inventory ≥ 15 with REAL or PLACEHOLDER skill anchors documented
- [x] CI strip-check enforces no Claude-only token regressions
- [x] Research artifact recommends a path for MCP UI integration with evidence
- [x] MCP Resources advertised by ≥ 1 omm MCP server
- [x] MCP Prompts advertised by omm-mcp
- [x] Automated MA-consumer wire-contract roundtrip passes — evidence: `.omc/state/ma-roundtrip-evidence.json` (generated by `node omm-scripts/omm-smoke-mcp.mjs --as-ma-consumer`); drop-in MA registry snippets: `docs/contracts/ma-integration-snippets.md`
- [x] Human-side confirmation: omm MCP servers seeded into `~/.openclaw/openclaw.json` via `omm-ma-seed.mjs --write`, MA restarted, three `omm-*` servers visible in MA's MCP catalog UI

---

## Non-Goals（明确不做）

These are deliberately excluded based on architectural decisions:

| Feature                   | Reason                                           | ADR                                           |
| ------------------------- | ------------------------------------------------ | --------------------------------------------- |
| Standalone CLI            | OpenClaw Gateway provides tool dispatch          | [ADR-001](adr/001-pure-plugin-no-cli.md)      |
| tmux/worktree parallelism | Host provides team primitives                    | [ADR-002](adr/002-team-delegation-to-host.md) |
| HUD / status bar          | Host UI layer (Electron) provides equivalent     | N/A                                           |
| Notification subsystem    | Host (MatrixAssistant) has its own notifications | N/A                                           |
| Rust native crates        | Not needed for plugin-only architecture          | [ADR-001](adr/001-pure-plugin-no-cli.md)      |
| Code-intel MCP            | OpenClaw may provide LSP integration natively    | N/A                                           |
