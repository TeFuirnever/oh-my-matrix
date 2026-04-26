# omm Changelog

All notable changes to oh-my-matrix (omm). The version line is currently
`0.2.0` across all packages; this changelog records what landed inside that
line by date and Phase. A `0.2.1` bump is deferred until the next consumer-
facing release window.

## [Unreleased] — 0.2.0 in-line work, 2026-04-26

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
