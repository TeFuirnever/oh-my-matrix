# omm Changelog

All notable changes to oh-my-matrix (omm).

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
