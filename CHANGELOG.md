# omm Changelog

All notable changes to oh-my-matrix (omm).

## [0.7.2] — 2026-06-28

**Runtime guard closed loop + open-source readiness.** The subagent runtime guard (a placebo in production) is fixed end-to-end with live e2e proof, and the repo is scrubbed for open-source release.

### Added

- **Runtime guard fix** — `@openclaw/dynamic-workflows` reads the real `event.params.command` (was `event.args`, never emitted → fail-open placebo). Per-segment shell split (`&&`/`&`/`|`/`;`/newline, `2>&1` lookbehind), `:subagent:` `defaultDeny` fail-closed, evasion blocks (destructive git / file cleanup / credential / shell substitution / wrapper-exec). Fix spec: [docs/fixes/runtime-guard-event-shape.md](docs/fixes/runtime-guard-event-shape.md).
- **Compile-time event-shape contract** — TS2353 reverse-verifies the guard reads the real `PluginHookBeforeToolCallEvent` shape.
- **CI** (`.github/workflows/ci.yml`) — `pnpm -r test` on push/PR (autopilot 528+4skip / permission-policy 118 / dynamic-workflows 12).
- **Hero image** (`.github/assets/hero.png`) + [`docs/credits.md`](docs/credits.md) provenance.
- **package.json discoverability** — `license` / `keywords` / `repository` / `homepage` / `author` / `bugs` on root + `@openclaw/*` packages.

### Changed

- **README rewritten** as a skill-package/library template for OpenClaw integrators: integration surface × runtime contract × skill content; status matrix (with limitations); `adopt @openclaw/dynamic-workflows vs hand-roll guard` comparison.
- **VitePress site** — `index.md` hero updated to 0.7.x; GitHub org placeholders → `TeFuirnever`; `docs.yml` trigger `main` → `master`.

### Security

- **Pre-open-source scrub** — untracked `.claude/settings.local.json` (consuming-host dev topology + local paths), history scrubbed via git-filter-repo; removed host-deploy tooling (`sync-to-ma.sh` ×3, `verify-guard.cjs`) + host runbook; abstracted host-internal paths in docs/ADRs; de-personalized test fixtures; explicit `private: true` (was null) + `publishConfig.access: restricted`.

### Verified

- **Live e2e closed (2026-06-28)** — real OpenProse subagent hard-blocked (`git reset --hard` → `destructive_git` / `block`) in audit; verify-guard drives 7 real-shape events (all pass) against the deployed dist.

## [0.7.1] — 2026-06-19

**`@openclaw/autopilot` source hosted in omm.** omm becomes a pnpm monorepo hosting the canonical `@openclaw/autopilot` plugin source; MatrixAssistant consumes it as an offline npm package. Hosting, not reimplementation — see [ADR-010](docs/adr/010-autopilot-source-hosting.md).

### Added

- **`packages/autopilot/`** — canonical `@openclaw/autopilot@2.0.0` source migrated from MatrixAssistant (the host's plugin source tree). 18 source modules, 43 test files (633 tests), `openclaw.plugin.json`, `tsconfig`, `vitest.config`. SDK import fixed from relative `node_modules` path to bare `openclaw` module.
- **`pnpm-workspace.yaml`** — omm is now a pnpm workspace (`packages/*`).
- **[ADR-010](docs/adr/010-autopilot-source-hosting.md)** — records the decision to host `@openclaw/autopilot` in omm rather than keep it embedded in MA; documents compatibility with ADR-008.

### Changed

- **MA consumes autopilot as a package** — `"@openclaw/autopilot": "<a versioned file: tgz dependency>"`; MA is self-contained (tgz vendored into its bundled-plugin directory), plugin discovery resolves from `node_modules` in dev and the bundled-plugin directory when packaged.
- omm `package.json` version bumped 0.6.0 → 0.7.1.

### Removed

- (MA side, recorded here for cross-repo traceability) the host's autopilot plugin source tree and build script removed from MatrixAssistant.

## [0.7.0] — 2026-06-18

**Dynamic Workflows.** AI-autonomous multi-agent orchestration for OpenClaw, modeled after Claude Code dynamic workflows. The agent generates `.prose` programs and executes them via OpenProse — no custom runtime built.

### Added

- **`skill/dynamic-workflows/SKILL.md`** — teaches OpenClaw agents to autonomously generate and run `.prose` workflow programs. Includes 8 orchestration patterns (fan-out-reduce, pipeline, adversarial-verify, loop-until-dry, routing, tournament, generate-and-filter, duel-loop), .prose syntax guide, generate-validate-repair loop, and trigger keywords.
- **`docs/adr/009-dynamic-workflows-via-openprose.md`** — records the decision to deliver dynamic workflows via OpenProse (route B) rather than building a custom JS runtime. Documents the v1→v8 design journey and E1–E4 pre-research evidence.
- **`docs/design/dynamic-workflows-design.md`** v8 — design document covering target, architecture, pre-research conclusions, implementation plan, and version evolution (v1→v8 across 3 adversarial reviews + 2 Codex sessions + 4 pre-research experiments).
- **Pre-research reports** (`.omc/specs/E{1-4}-*.md`, `route-decision.md`) — prompt ceiling, OpenProse boundary, subagent contract, registerTool model, route decision matrix.

### Changed

- **Docs spine** (`README.md`, `CONTEXT.md`, `docs/architecture.md`, `docs/roadmap.md`) updated from v0.6.0 "team direction reset" to v0.7.0 "Dynamic Workflows via OpenProse" direction.
- `team` orchestration direction superseded by dynamic-workflows ([ADR-009](docs/adr/009-dynamic-workflows-via-openprose.md)).

## [0.6.0] — 2026-06-18

**Strip-to-docs reset.** The entire v0.x implementation is removed; the repository becomes a documentation & design foundation for the next direction. The design vision stays continuous (OpenClaw-native `team` orchestration); implementation is reset.

### Removed

- **All code**: `omm-packages/` (omm-plugin, omm-mcp, omm-skills — sources, tests, agent-prompts, SKILL.md), `omm-scripts/` (build / seed / verify `.mjs`), `omm-dist/` (suite tarball), `coverage/`.
- **Build toolchain**: `tsconfig.base.json`, `biome.json`, `pnpm-workspace.yaml`, `omm-provenance.json`, `pnpm-lock.yaml` (regenerated).
- **Code CI**: `.gitlab-ci.yml`, `.github/workflows/ci.yml`. (`.github/workflows/docs.yml` retained — builds & deploys the VitePress site.)
- `package.json` slimmed to docs-only: kept `docs:dev` / `docs:build` / `docs:preview` and the `vitepress` devDependency; dropped `build`/`lint`/`test`/`test:coverage`/all `omm:*` scripts and `@biomejs/biome` / `@types/node` / `typescript`.

### Changed

- **Implementation-bound docs archived** under `docs/archive/` (contracts/, plans/, specs/, reviews/, research/, and ADRs 001/003/004/005/006/007) with a per-file banner — design knowledge preserved, demoted out of the live surface. See `docs/archive/README.md`.
- **Spine docs reworked** to reflect the docs-only reality: `README.md`, `AGENTS.md`, `CONTEXT.md`, `CONTRIBUTING.md` rewritten; `docs/architecture.md` and `docs/roadmap.md` marked with an "implementation reset" banner and pruned of dead implementation inventories.
- **ADR-002 / ADR-008** (delegation philosophy) retained at `docs/adr/` as the continuous-direction spine.
- **Website** simplified: stale tool/mode/tarball content rewritten; archived mirror pages removed.

## [0.5.0] — 2026-06-16

Two themes: tool-surface reduction (focus on `team` + employee bridge) and team multi-agent enhancement (fork-join + synthesis).

### Removed

- **Non-team plugin tools** dropped from `omm-register.ts` registration: `omm_ping`, `omm_cancel`, `omm_state_list`, `omm_agent_prompt_get`, `omm_agent_prompt_list`. The underlying handlers stay (consumed by `omm-mcp`); only the plugin tool surface is trimmed. Registered tools: 8 → 6.
- **`omm-mcp-memory` and `omm-mcp-trace` packages** deleted as non-essential. Only `omm-mcp` (state + prompts) ships.
- **`omm-ping` / `omm-cancel` skills** removed (skills shipped: → 1, `omm-team`).
- `verifyAgentPromptsAvailable` startup sentinel removed (agent-prompt tools no longer registered at plugin layer).

### Added

- **`omm_employee_result_batch`** plugin tool — `Promise.all` concurrent collection of N dispatch results in one tool call. Required because `omm_employee_result` blocks up to 60s per runId and LLM tool calls execute sequentially; without a batch tool, fork-join collection is physically impossible. Caps at 10 runIds.
- **`before_compaction` / `after_compaction`** hook events (pure dispatch) + the full 14-hook `hooks` array declared in `openclaw.plugin.json`.
- **`synthesizing`** phase in the `team` state machine (non-terminal) + **`subtasks`** array structural validation in `validateTeam` (guards against malformed LLM state writes).
- Typed `PollOutcome` discriminated union returned by `pollSingleResult`, consumed cleanly by both the single and batch tools (no envelope reverse-engineering).

### Changed

- **`omm-team` SKILL.md rewritten** for persona-aware (`roleId`) task assignment, fork-join dispatch (write runIds to state immediately — LLM need not track UUIDs), and a result-synthesis phase (dispatch `critic` when `agent_count > 1`).
- **MA dispatch-watcher spec** (`docs/plans/omm-ma-employee-bridge.md`) updated to mandate `Promise.all` concurrent processing of distinct runIds — without it, OMM-side parallel dispatch yields no wall-clock gain.
- `pollSingleResult` no longer re-reads `resultPath` twice per poll tick (one read; `requestPath` read only when result is missing).
- Version bumped to **0.5.0** across all three `package.json` files, `openclaw.plugin.json`, and the `omm-register.ts` `version` const.

### Docs synced to reality

- `README.md` package table (removed memory/trace rows), `docs/architecture.md` (6 tools / 14 hooks), `docs/roadmap.md` (264 tests / v0.5.0), `CONTEXT.md` (phase list incl. `synthesizing`; hook count 14), `docs/contracts/{hooks,error-codes,mcp}.md`, `docs/adr/008` (v0.5 tool-count note).
- `AGENTS.md` high-risk list corrected — it previously pointed at MatrixAssistant paths (`electron/main`, `packages/gateway`, `packages/bastion`) that do not exist in this repo; now references omm's actual risk surfaces (state validation, cross-process locking, plugin ABI, employee relay, inline MCP build).

### Test count

255 → **264** (+9: batch tool concurrent/timeout/validation, `synthesizing` phase, `subtasks` schema validation, `synthesis` persistence).

## [Unreleased]

### Changed

- `omm-ma-seed.mjs` updated to OpenClaw native MCP format: targets
  `~/.openclaw/openclaw.json` with `mcp.servers` nested structure, uses
  `{ command, args, env? }` entries without `type`/`enabled`/`tags`.
- `docs/contracts/ma-integration-snippets.md` rewritten to match MA's current
  OpenClaw-native config format and path.
- `SHIPPED_SKILLS` in `omm-build-suite.mjs` narrowed to 5 core skills
  (omm-ping, omm-cancel, omm-ralph, omm-team, omm-autopilot). The 9 extended
  skills (omm-deep-interview, omm-ralplan, omm-ultrawork, omm-ultraqa,
  omm-docs, omm-ui, omm-git, omm-research, omm-refactor) remain in
  v0.x skill bundles (since removed — see docs/archive/) but are excluded from the suite tarball to focus
  MA integration testing on the core workflow engine.

### Added

- `omm-scripts/omm-ma-seed.mjs` — dry-run-first MatrixAssistant MCP registry
  seeder for user/project/local scopes. It writes MA-readable stdio server
  entries for `omm-state`, `omm-memory`, and `omm-trace` only when `--write`
  is provided.
- `omm-scripts/omm-openclaw-seed.mjs` — dry-run-first OpenClaw plugin registry
  seeder for `~/.openclaw/openclaw.json`. It registers the bundled `omm`
  plugin path, allowlist entry, and plugin config without clobbering custom
  entries unless `--force` is provided.
- P2 benchmark parity prompts: `git-master`, `scientist`, and
  `code-simplifier`, ported from oh-my-claudecode and adapted to OpenClaw
  tool semantics.
- P2 skill anchors: `omm-git`, `omm-research`, and `omm-refactor`, connecting
  the new prompts to user-invocable workflows.
- Script-level regression tests for package entrypoints, seeders, and shipped
  suite skills.
- `WorkflowStateOf<M>` mapped type in `omm-types.ts` — maps a `WorkflowMode`
  literal (`"ralph"` | `"autopilot"` | `"team"`) to its corresponding
  state shape (`RalphState` | `AutopilotState` | `TeamState`). Lets the
  lifecycle API give callers compile-time narrowing without manual casts.

### Changed

- `omm-build-suite.mjs` now uses one `SHIPPED_SKILLS` list and copies all 14
  release skills to both `omm-skills/` and `omm-plugin/skills/`.
- `docs/architecture.md`, `docs/roadmap.md`, and website guide copies now
  describe the current release surface: 14 shipped skills, 19 agent prompts,
  3 MCP servers, dry-run seeders, and 411 passing tests.
- `omm-mode-lifecycle.ts` lifecycle API (`startMode`, `updateModeState`,
  `cancelMode`, `getModeState`) now generic over `M extends WorkflowMode`.
  Return types use `WorkflowStateOf<M>` instead of
  `Record<string, unknown>`. Callers get narrowed state shapes:
  `getModeState("ralph")` returns `RalphState | null` directly.
- Internal `writeState` helper kept untyped (`InternalWriteResult`) since
  it operates on validated-but-untyped JSON; the public API casts at the
  boundary. This concentrates the `as` cast in one location instead of
  spreading it across every caller.
- `docs/contracts/skill-lifecycle.md` — canonical lifecycle contract
  (added in earlier Unreleased entry).
- `omm-skills/{omm-docs,omm-ui,omm-deep-interview,omm-ultraqa}/SKILL.md` —
  reference contract instead of restating lifecycle protocol verbatim.
- `CONTEXT.md` — Skill definition introduces "Lifecycle Conventions" and
  "3-Phase Pipeline Pattern" as domain terms.

### Fixed

- MCP inline generation and drift verification now share a hygiene guard that
  removes failed generated fragments and rejects standalone `null` sentinels.
- Bundle verification now derives the expected manifest version from
  `package.json`, and `omm:verify-bundle` targets the current `0.4.2` tarball.

## [0.4.2] — 2026-05-08

### Added

- **omm-docs skill** (v0.x skill bundle, since removed — see docs/archive/) —
  documentation generation pipeline orchestrating document-specialist
  (research) and writer (draft), followed by a verification phase
  (code-block execution + link checks + slop scan). Three-phase
  separation enforces "writer never invents facts".
- **omm-ui skill** (v0.x skill bundle, since removed — see docs/archive/) —
  UI artifact generation pipeline (component / spec / theme outputs)
  orchestrating the designer agent across discover → generate →
  verify phases. Mandates a domain check that overrides the model's
  editorial-leaning defaults for operational briefs (dashboards,
  fintech, healthcare, dev tools). Produces deliverable files for
  the host (e.g., MatrixAssistant) — does not render UI itself
  (ADR-001).
- Skill count: 9 → 11.

### Changed

- Agent inventory in `CONTEXT.md`: `document-specialist`, `writer`,
  and `designer` all flipped from PLACEHOLDER to REAL — anchored to
  `omm-docs` (writer + document-specialist) and `omm-ui` (designer).
- Placeholder agent count drops from 3 to **0**. Every P0/P1 agent
  in the inventory now has a real skill consumer.
- REAL agents count rises from 13 to 16.

## [0.4.1] — 2026-05-08

Agent prompt expansion + MCP capability research per plan
ralplan-omm-next-best-practices (2026-05-08).

### Highlights

- **Agent inventory: 5 → 16 prompts** (5 starter + 11 ported from
  oh-my-claudecode). Ports cover the core development lifecycle:
  planner, tracer, code-reviewer, security-reviewer, test-engineer,
  debugger, qa-tester, explore, document-specialist, designer, writer.
- **7-token strip-check in CI** prevents Claude-only semantic tokens
  (`Task(subagent_type=`, `AskUserQuestion`, `Agent(`, `lsp_diagnostics`,
  `ast_grep_search`, `<External_Consultation>`, `mcp__plugin_oh-my-claudecode`)
  from leaking into ported prompts.
- **MCP capability research**: `docs/research/mcp-capability-survey.md`
  documents that the OpenClaw + MatrixAssistant client stack already
  supports `resources/list` and `prompts/list` via `@modelcontextprotocol/sdk`.
  Recommends R1 (upgrade omm MCP servers to advertise Resources + Prompts,
  ~140 LOC, additive, ADR-003 compliant) for a follow-up plan.

### Added

- 11 ported agent prompts (v0.x skill bundles, since removed — see docs/archive/):
  planner, tracer, code-reviewer, security-reviewer, test-engineer,
  debugger, qa-tester, explore, document-specialist, designer, writer
- `docs/research/mcp-capability-survey.md` — Phase 2 deliverable
- `omm-agent-prompts.test.ts`: new `describe("expanded agent inventory")` block
  with 3 tests (count ≥ 16, 7-token strip-check across 11 prompts,
  OpenClaw tool-reference regex check)

### Changed

- omm-ralplan skill (v0.x skill bundle, since removed — see docs/archive/): Step 1 now loads `planner`
  agent prompt (was loading `analyst`, which was a known label-vs-load mismatch).
- `CONTEXT.md`: Agent Prompt section extended with bundled count (16),
  Prompt Style Coexistence Policy (lean vs XML-structured), Agent Inventory
  table (REAL/PLACEHOLDER distinction), and 2 new Known Trade-offs entries
  (ported prompt drift risk, placeholder agents).

### Test Metrics

- Tests: 373 → 376 (3 new expanded-inventory tests)
- All tests pass; lint clean (0 issues across 67 files)

### Deferred (follow-up plans)

- P2 agents (git-master, scientist, code-simplifier) — will be ported
  when omm-git / omm-research / omm-refactor skills are scheduled
- ~~MCP R1 implementation~~ — **Done** (see "MCP R1" subsection below)
- ~~`notifications/progress` capability verification~~ — **Done** (DEFER per
  MA self-audit P6 evidence; see `docs/research/mcp-progress-notification-survey.md`)

### Added (MCP R1)

- `omm-mcp` advertises MCP Resources via `omm://state/<key>` (one URI per
  state JSON file) with `application/json` MIME type. New methods:
  `resources/list`, `resources/read`. Capability advertised in `initialize`.
- `omm-mcp` advertises MCP Prompts via `omm://prompts/<name>` for the 16
  bundled agent prompts. New methods: `prompts/list`, `prompts/get`.
  Returns prompt body as `system` message per MCP spec. Capability advertised
  in `initialize`.
- `omm-mcp-trace` advertises MCP Resources via `omm://trace/<sessionId>`
  (one URI per trace JSONL file) with `application/x-jsonlines` MIME type.
  New methods: `resources/list`, `resources/read`.
- `docs/contracts/mcp.md` — new contract document covering URI scheme,
  capability matrix, and Prompts placement rationale.

### Changed (MCP R1)

- `omm-mcp` `initialize` capabilities: `{ tools: {} }` →
  `{ tools: {}, resources: {}, prompts: {} }`.
- `omm-mcp-trace` `initialize` capabilities: `{ tools: {} }` →
  `{ tools: {}, resources: {} }`.
- `omm-mcp-memory` unchanged (advertises tools only; out of R1 scope).

### Test Metrics (post-R1)

- Tests: 376 → 389 (13 new across both servers' Resources + Prompts surfaces)
- All tests pass; lint clean; no new runtime dependencies (zero-dep ADR-003 preserved)

## [0.4.0] — 2026-05-06

Phase 4: OpenClaw hook alignment + 4 core skills for the 3-stage pipeline
(deep-interview → ralplan → autopilot).

### Highlights

- **Hook upgrade**: `omm-hooks.ts` now handles 12 OpenClaw lifecycle events
  (up from 5). Replaced non-existent `pre_tool_use`/`post_tool_use`/`mode_change`
  with OpenClaw's actual `before_tool_call`/`after_tool_call` and 7 new
  events (`llm_input`, `llm_output`, `agent_end`, `subagent_spawning`,
  `subagent_spawned`, `subagent_ended`, `gateway_start`, `gateway_stop`).
- **Auto-trace**: Hook handlers for tool calls, LLM I/O, and agent_end
  automatically append trace events to `{stateRoot}/trace/{sessionId}.jsonl`
  when `sessionId` is present — no manual `omm_trace_record` calls needed.
- **4 core skills** (AgentSkills-compatible SKILL.md):
  - `deep-interview`: Socratic requirement clarification with mathematical
    ambiguity scoring (Goal 40% / Constraints 30% / Criteria 30%), challenge
    agents at rounds 4/6/8, ontology tracking. Output: `.omm/specs/deep-interview-{slug}.md`.
  - `ralplan`: 3-role consensus planning (Planner → Architect → Critic) with
    max 5 rounds. Deep-interview spec auto-detection. Output: `.omm/plans/ralplan-{slug}.md`.
  - `ultrawork`: Parallel execution with dependency-aware task graphs, 5 phases
    from intent grounding to verification. Minimal state component.
  - `ultraqa`: Autonomous QA cycling (test → verify → diagnose → fix → repeat),
    max 5 cycles, same-error-3-times stuck detection.
- **3-stage pipeline wired**: `deep-interview → ralplan → autopilot` end-to-end
  path from vague idea to working code.

### Changed

- `omm-hooks.ts`: `OmmHookEvent` union type expanded to 12 events.
  `handlePreToolUse`/`handlePostToolUse`/`handleModeChange` replaced by
  `handleBeforeToolCall`/`handleAfterToolCall` plus 7 new handlers.
- `omm-register.ts`: Plugin `api.on()` registrations updated from 5 to 12 hooks.
- `docs/contracts/hooks.md`: Updated event table and directory layout.

### Added

- `omm-skills/omm-deep-interview/SKILL.md`
- `omm-skills/omm-ralplan/SKILL.md`
- `omm-skills/omm-ultrawork/SKILL.md`
- `omm-skills/omm-ultraqa/SKILL.md`

### Test count

373 passing (was 342; +31 new tests for trace recording, handler dispatch,
and expanded hook coverage).

### Known limitations

- Auto-trace requires the host (OpenClaw runtime) to emit lifecycle events
  with `sessionId` in the args. Without `sessionId`, trace recording is
  skipped silently. Hook dispatch still fires regardless.

## [0.3.0] — 2026-04-28

First commercial GA release. Promotes 0.3.0-beta.1 to stable after host
integration verification (MatrixAssistant `omm-bundle` + `omm-plugin-smoke`
14/14 green; agent-prompts bundling gap closed in MA host).

### Highlights since 0.2.x

- 7 plugin tools (`omm_ping`, `omm_cancel`, `omm_state_{write,read,list}`,
  `omm_agent_prompt_{get,list}`).
- 3 MCP servers (`omm-state`, `omm-memory`, `omm-trace`) with structured
  observability metrics and rotating logs.
- Cross-process file locking (`withCrossProcessLock`, ADR-005) — plugin
  and MCP servers no longer last-write-wins on the same `stateRoot`.
- Hook dispatcher (`omm-hook-loader.ts`) and lifecycle wiring complete.
  Auto-emit of lifecycle events depends on OpenClaw runtime support;
  upstream PR drafted at `MatrixAssistant/docs/proposals/openclaw-lifecycle-events.md`.
- Structured error codes (`OMM_E_*`) and `apiVersion: "0.3"` capability
  contract.
- 5 bundled agent prompts (analyst / architect / critic / executor / verifier).

### Known limitations

- Auto-hook event source: dispatcher present, OpenClaw runtime does not
  yet emit lifecycle events. LLM workflows (ralph / autopilot / team) call
  `omm_state_write` / `omm_trace_record` explicitly; full auto-emit lands
  once the upstream proposal merges.

## [0.3.0-beta.1] — 2026-04-28

### Added

- **agent-prompts (plugin tool)**: New plugin tools `omm_agent_prompt_get`
  and `omm_agent_prompt_list` expose the agent persona library to hosts.
  The loader (`omm-agent-prompts.ts`) was already shipped in 0.3.0-alpha.1
  but was not callable from the LLM layer. Hosts now have a structured
  surface to delegate a turn to a specialised persona (architect / reviewer
  / planner …) via the same JSON-RPC channel used for state and memory.
  - `omm_agent_prompt_get({ name })` returns `{ body, details: { name,
modelTier, purpose } }`. Throws on missing/invalid name.
  - `omm_agent_prompt_list({})` returns `{ names, count }` sorted ascending.
  - Plugin config: `promptsDir` (optional override for tests / out-of-bundle
    prompt sets).

### Changed

- Version bumped to **0.3.0-beta.1** across `package.json` and all four
  packages (`omm-plugin`, `omm-mcp`, `omm-mcp-memory`, `omm-mcp-trace`).
  All P0 commercial-blocker work is now closed:
  - P0-1 cross-process locking — shipped in alpha.2
    (`withCrossProcessLock` + ADR-005 + 3 MCP server adoption + Windows
    EPERM retry fix).
  - P0-2 plugin tool real-machine smoke — `scripts/omm-plugin-smoke.mjs`
    in MatrixAssistant.
  - P0-3 mcporter startup health check — `electron/main/services/mcp/
omm-health.ts` in MatrixAssistant + dialog on miss + 30s retry.

### Outstanding for 0.3.0 GA

- **P1-1 hook event sources**: `dispatchHooks()` exists in `omm-plugin`
  but no OpenClaw runtime emits the lifecycle events (session_start,
  session_end, pre/post_tool_use, mode_change). Requires an OpenClaw
  upstream PR to wire runtime events through the plugin `api.on` surface.
  Tracked separately.

## [0.3.0-alpha.2] — 2026-04-27

### Added

- **observability**: `omm_trace_metrics` MCP tool aggregates execution
  metrics from trace records — returns `{ count, errorRate, p50, p99,
byTool: { [toolName]: { count, errorRate, p50, p99 } } }`. Optional
  `sessionId` and `sinceMs` filters. `omm_trace_record` schema now
  accepts optional `durationMs`, `toolName`, `ok` fields for hosts
  that want to surface tool perf to operators. Backward compatible —
  existing callers omitting these fields keep working. See
  `docs/contracts/observability.md`.

- **errors (mcp)**: All three MCP servers (omm-state, omm-memory,
  omm-trace) now emit structured error codes via JSON-RPC
  `error.data.code`, completing the migration started in
  0.3.0-alpha.1. Hosts can branch on stable identifiers like
  `OMM_E_KEY_INVALID`, `OMM_E_VALUE_INVALID`, `OMM_E_IO_FAILED`
  rather than substring-matching free-form strings. `error.message`
  preserved for backward compat. See `docs/contracts/error-codes.md`.

### Fixed

- `omm-fs-queue.ts` and inline copies in 3 MCP servers: O_EXCL retry
  loop now also catches Windows `EPERM` (not just `EEXIST`) — Windows
  reports EPERM when racing on an already-open file. Without this fix
  the cross-process lock spuriously failed on Windows under contention.

### Changed

- `omm-stress-cross-process.mjs`: P99 budget raised from 100 ms to
  200 ms to reflect the Windows EPERM retry cost (~50 ms extra per
  contention event). The budget still detects pathological contention
  but is honest about platform-dependent jitter. Linux/macOS
  performance unchanged (P99 still ~65 ms). See ADR-005 Windows quirk
  section for details.

## [0.3.0-alpha.1] — 2026-04-27

### Added — P0 hardening (multi-process safety)

- `omm-fs-queue.ts`: new `withCrossProcessLock(lockDir, key, fn,
{ timeoutMs?, staleMs? })` — `O_EXCL`-based file lock at
  `${lockDir}/.locks/${key}.lock` with 50 ms ± 20 ms jitter polling,
  30 s stale-lock recovery (mtime + PID liveness via
  `process.kill(pid, 0)`), and `try/finally` release. Wrapped in the
  existing in-process `withKeyLock` so same-process awaiters do not
  fight for the file. Throws
  `Error("OMM_E_LOCK_TIMEOUT: <key>")` after `timeoutMs` (default
  5 s).
- `omm-tools/omm-state.ts`: `runOmmStateWrite` now uses
  `withCrossProcessLock(stateDir, key, …)` so the
  validate→exclusivity-check→write→rename window is serialized across
  the plugin process AND every MCP server process sharing the same
  `${stateRoot}`.
- `omm-mcp`, `omm-mcp-memory`, `omm-mcp-trace`: each server inlines a
  byte-equivalent `withCrossProcessLock` (zero-dep per ADR-003 — they
  cannot import `omm-plugin`). Callsites:
  - `omm-mcp` `toolWrite` → wraps validate+rename window.
  - `omm-mcp-memory` `toolSet` / `toolDelete` → wraps tmp+rename / unlink.
  - `omm-mcp-trace` `toolRecord` → wraps rotate→appendFile.

### Added — Documentation

- `docs/adr/005-cross-process-locking.md`: rationale for the
  `O_EXCL` self-implementation, the inlined-copy maintenance cost,
  failure semantics, and rejected alternatives (`proper-lockfile`,
  POSIX `flock` via native addon, SQLite, single shared-mutex daemon).

### Added — Tooling

- `omm-scripts/omm-stress-cross-process.mjs`: spawns 4 child processes
  (2 plugin direct-call, 2 MCP-server stdio) hammering the same key
  100× each. Reports P50 / P99 latency. Exits 0 only when no lock
  errors occur AND P99 < 100 ms.

### Added — Tests

- `omm-fs-queue.test.ts`: 5 new cases covering happy-path
  serialization, EEXIST retry until release, stale-lock cleanup with
  dead PID, `OMM_E_LOCK_TIMEOUT` exhaustion, and try/finally cleanup
  on throwing `fn`.

### Changed — Versions

- Root `package.json` 0.2.2 → 0.3.0-alpha.1.
- `omm-plugin`, `omm-mcp`, `omm-mcp-memory`, `omm-mcp-trace`
  sub-packages 0.2.2 → 0.3.0-alpha.1.
- All three MCP `serverInfo.version` strings 0.2.2 → 0.3.0-alpha.1.
- `omm-smoke-mcp.mjs` `EXPECTED_VERSION` synced.

### Security posture

The cross-process write race documented as known-limitation in 0.2.x
is now mechanically prevented across the plugin process and the three
MCP server processes. Single-host operation only — `process.kill` PID
liveness checks cannot detect remote-crashed PIDs on a shared NFS
stateRoot, in which case stale recovery waits the full `staleMs`
window (30 s by default).

---

## [0.2.2] — 2026-04-27

### Fixed — P0 production bug (escaped 0.2.1)

- `omm-register.ts`: corrected all 5 plugin tool `execute` signatures
  from the wrong 1-arg form `(params)` to the OpenClaw runtime's actual
  4-arg shape `(toolCallId, params, signal?, onUpdate?)`. The 1-arg
  form silently captured the `toolCallId` string as `params`, so every
  `params.field` access returned `undefined`. omm_state_read/write/list
  rejected with `"key is required"`; omm_ping/cancel silently fell
  through to defaults. The MCP server path was unaffected (uses
  standard MCP `tools/call` envelope), which is why both
  `pnpm omm:smoke-mcp` and `omm-bundle-smoke.mjs` passed despite the
  plugin path being broken.
- Hardened the local `OmmPluginApi.execute` type to the 4-arg shape so
  future regressions are caught at compile time, not by users in
  production Electron sessions.

### Added — Tests

- `omm-register.test.ts`: 7 integration tests that mock the OpenClaw
  `registerTool` API and invoke each registered tool's `execute` with
  the real 4-arg shape. Direct regression guard for the 0.2.1 bug:
  `omm_state_read({key:"x"})` must return `"null"` (not
  `"key is required"`) when the file is missing.

### Test count

342 passing (was 339; +3 register integration tests for state-read,
state-write+list+round-trip, ping; +2 for cancel + signal-omitted; +1
fixture).

### Discovery context

Real-Electron smoke 2026-04-26 surfaced the bug: the model in
MatrixAssistant kept hallucinating "tool unavailable" after seeing
the wrong error string from omm_state_read. Architect + verifier +
same-class-bug-sweep reviewer trio confirmed the diagnosis: 5
instances all in `omm-register.ts`, 0 collateral elsewhere. SKILL.md
"null is not an error" hint shipped in 0.2.1 doesn't help — calls
never reached the success path because params were lost first.

---

## [0.2.1] — 2026-04-26

### Added — Hardening (post-architecture-review)

- `omm-fs-queue.ts`: in-process per-key serialization queue. Wraps the
  validate→exclusivity-check→write→rename window in `runOmmStateWrite`
  (omm-plugin) and `toolWrite` (omm-mcp) so two concurrent writers to
  the same key cannot last-write-wins past the exclusivity guard.
- MCP servers: 1 MiB hard cap on each JSON-RPC request line in all 3
  servers (omm-mcp, omm-mcp-memory, omm-mcp-trace). Oversized requests
  return JSON-RPC error -32600 instead of buffering unboundedly.
- `omm-mcp-trace`: size-based rotation. Sessions over 8 MiB are rolled
  over to `${session}.jsonl.${ms}` archives; up to 4 archives retained
  (40 MiB ceiling per session). Query reads across archive + current
  in chronological order. Per-session in-process lock closes the
  rotate→appendFile TOCTOU window.

### Documentation

- `.gitattributes` locks LF on text files to keep dist/ stable on
  Windows checkouts (autocrlf=true was churning artifacts).
- `AGENTS.md` / `CLAUDE.md` (alias) committed for repo conventions.

### Test count

256 unit tests (was 248 in 0.2.0). All green.

### Security posture

The single-user desktop deployment model remains the operational
contract. Cross-process write races between plugin and MCP server are
still possible — single-writer-per-stateRoot is the documented
invariant. Multi-process locking is out of 0.2.x scope.

---

## [0.2.0] — 2026-04-26

### Added — Phase 1: Workflow Runtime

- `omm-tools/omm-state.ts`: `omm_state_write` / `omm_state_read` /
  `omm_state_list` plugin tools, with key sanitization (path-traversal
  defense) and atomic tmp+rename writes. _(Phase 1a)_
- `omm-state-validation.ts`: three-mode validator dispatcher
  (ralph / autopilot / team) with shared terminal rules and default injection.
  _(Phase 1a)_
- `omm-workflow-guard.ts`: `assertWorkflowExclusivity` — only one of
  ralph / autopilot / team may be `active=true` simultaneously, with the
  unidirectional ralph↔team `linked_ralph` exception. _(Phase 1b/1)_
- MCP server integration tests for `omm-mcp` (handshake, tools/call,
  exclusivity guard via the MCP path, error codes). _(Phase 1b/2)_
- `omm-run-outcome.ts`: `RunOutcome` typed terminal contract with
  `makeRunOutcome`, `phaseToOutcomeKind`, `deriveOutcomeFromState`.
  _(Phase 1b/3)_
- `omm-mode-lifecycle.ts`: `startMode` / `updateModeState` / `cancelMode` /
  `getModeState` host-friendly API composing validation, exclusivity,
  atomic write, and outcome stamping. _(Phase 1b/4)_
- `omm-ralph-prd.ts`, `omm-ralph-progress.ts`, `omm-ralph-resume.ts`:
  structured PRD persistence, append-only JSONL progress ledger, and
  cross-session resume composer. _(Phase 1b/5)_
- `omm-autopilot-pipeline.ts`: typed `Stage` helpers for autopilot's
  multi-step plan (validatePlan, getCurrentStage, markStageStatus,
  advanceStage, incrementRetry). _(Phase 1 closeout)_

### Added — Phase 2: Extended MCP

- `omm-mcp-memory` package: stdio JSON-RPC server with
  `omm_memory_set/get/delete/list` over `{stateRoot}/memory/`. Zero-dep
  per ADR-003. _(Phase 2/1)_
- `omm-mcp-trace` package: append-only JSONL execution event log with
  `omm_trace_record/query/list_sessions` and inclusive time-range
  filtering. Zero-dep. _(Phase 2/2)_
- `omm-build-suite.mjs` bundles the two new MCP packages alongside
  `omm-mcp`. _(Phase 2/3)_
- `MatrixAssistant/scripts/omm-bundle.mjs` extracts memory + trace MCP
  servers into `resources/mcp/`. _(Phase 2/3)_
- `MatrixAssistant/resources/mcp/mcporter-default-config.json` registers
  `omm-memory` and `omm-trace` so mcporter discovers them at startup.

### Added — Phase 3: Polish & Extensibility

- `omm-skills/agent-prompts/`: starter library of 5 reusable role
  prompts (architect, critic, executor, analyst, verifier), each with
  `name`/`model_tier`/`purpose` frontmatter and a system-prompt body.
  _(Phase 3/1)_
- `omm-agent-prompts.ts`: `parseAgentPrompt`, `loadAgentPrompt`,
  `listAgentPrompts` — hand-rolled YAML frontmatter parser, path-traversal
  protected. _(Phase 3/1)_
- `omm-hook-loader.ts`: `loadHooks` / `dispatchHooks` for dynamic hook
  module loading from a configurable directory, parallel dispatch with
  per-hook error isolation. _(Phase 3/2)_
- `pnpm test:coverage` script using `npx -y c8` (no permanent dep). The
  bundled suite measures 96.83% statements / 98.27% functions / 91.07%
  branches across 1,831 statements. _(Phase 3/3)_

### Documentation

- Architecture review (`docs/reviews/2026-04-26-architecture-review.md`)
  identifying P0 gaps, scoring commercial readiness 28/100 at start.
- Four ADRs (`docs/adr/001-004`) covering pure-plugin posture, team
  delegation to host, zero-dep MCP, three-mode state machine.
- Three contract docs (`docs/contracts/`) covering state, workflow state,
  and MCP protocol.
- `docs/architecture.md`, `docs/roadmap.md` updated incrementally as each
  phase landed.
- `omm-skills/omm-ralph/SKILL.md` and `omm-skills/omm-autopilot/SKILL.md`
  now point at the unified mode-lifecycle and pipeline helper APIs as
  the recommended path.

### Security

- Path-traversal hardening on every state/memory/trace key (whitelist
  pattern `^[a-z0-9][a-z0-9_-]{0,63}$/i`).
- Hooks converted from `writeFileSync` to async `fs/promises` to avoid
  blocking the event loop.
- Workflow exclusivity guard prevents the "zombie state" failure mode
  where two workflow modes silently both run as `active=true`.

### Test count

25 → 248 unit tests (full omm-plugin + 3 MCP servers). All green.

### Commercial readiness score

Baseline 28/100 (per the architecture review) → ~78/100 after the three
phases. Production-ready for the desktop single-user deployment model;
multi-session and network-exposed deployments would need additional
locking and authentication work, which is outside Phase 3 scope.
