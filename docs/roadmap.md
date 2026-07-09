# omm Development Roadmap

This roadmap describes the current OpenClaw runtime stack direction. v0.x team/MCP work is archived under [`docs/archive/`](archive/) and is no longer the active implementation surface.

## Current North Star

Make OpenClaw capable of safe long-running and parallel autonomous work:

- **Autopilot** keeps one goal moving across turns, retries, stalls, evidence checks, and host UI projection.
- **Dynamic Workflows** fans work out across many subagents through `.prose` and OpenProse.
- **Permission Policy** gives both paths the same runtime safety primitives.

## P0: Public Truth Alignment

| Deliverable | Why | Status |
|---|---|---|
| README positions Autopilot as a first-class module | Existing README underrepresented the largest active package | Done 2026-06-28 |
| Architecture docs show all three modules | Prevents future drift toward “Dynamic Workflows only” | Done 2026-06-28 |
| Website getting-started matches current packages | Old site said the repo was docs-only | Done 2026-06-28 |
| Asset credits include hand-drawn hero and architecture diagram prompts | Generated images must be reproducible and licensed | Done 2026-06-28 |

Exit criteria:

- README, `CONTEXT.md`, `docs/architecture.md`, `website/index.md`, and getting-started agree on module boundaries.
- No public doc claims package release or adoption evidence that does not exist.
- `pnpm docs:build` passes.

## P1: Host Deploy Runbook

| Deliverable | Why | Status |
|---|---|---|
| Internal host-deploy steps documented | Source tests do not prove the host loaded new dist | In progress 2026-06-29 — skeleton in [`runbooks/host-deploy.md`](runbooks/host-deploy.md); host-internal steps `[TODO:host]` |
| Deployed-dist smoke checklist | Runtime guard and autopilot hooks can fail by event-shape drift | Planned |
| Package refresh contract for consuming OpenClaw hosts | Keeps vendored/bundled plugin copies auditable | Planned |

Exit criteria:

- A maintainer can rebuild `autopilot`, `dynamic-workflows`, and `permission-policy`, refresh the host copy, restart the gateway, and prove the loaded dist matches source.

## P2: Autopilot Release Readiness

| Deliverable | Why | Status |
|---|---|---|
| Public package policy | Packages are on npm public (autopilot / dynamic-workflows / permission-policy) but lack a documented consumer install + version policy | Planned |
| `WORKFLOW.md` examples | Autopilot config exists but needs copy-pasteable examples | Planned |
| Projection contract docs | Host UI needs stable fields and failure semantics | Done 2026-07-03 (Milestone C, #70) |
| Public type exports (`AutopilotProjection` from barrel) | Hosts previously deep-imported `dist/src/projection`, coupling to OMM's internal layout | Done 2026-07-03 (Milestone C, #70) |
| Evidence gate examples | Users need to understand required vs optional validation | Planned |

Exit criteria:

- Autopilot has a documented integration path, config examples, and host UI contract.
- Public types (`AutopilotProjection`) exported from the package barrel; no consumer reaches into `dist/src/`.
- `pnpm --filter @oh-my-matrix/autopilot test` remains green.

## P3: Dynamic Workflows Observability

| Deliverable | Why | Status |
|---|---|---|
| Projection contract (`DynamicWorkflowProjection`) | Large fan-out runs need a stable, read-only data shape for UI/consumers | Done 2026-07-03 (Milestone C, #70) |
| Host/UI rendering of branch graph, blocked calls, evidence | The projection is built but no host renders it yet | Planned (Milestone D) |
| Pattern examples gallery | The 11 workflow patterns need realistic examples (the "8" historically refers to the OpenProse-covered core patterns per ADR-009 E2; SKILL.md lists 11 including judge-panel, completeness-critic, multi-lens-sweep). Audit/review templates exist; refute-gate-compatible productive templates (implement-review-duel, test-generation-filter, candidate-tournament) added 2026-07-09 — remaining gaps are pure parallel-implement and batch-migrate, which are out of scope (no natural refute gate; see `skill/SKILL.md` § Refute-gate compatibility). | In progress |

Design references:

- [`docs/design/dynamic-workflows-projection-design.md`](design/dynamic-workflows-projection-design.md)
- [`docs/design/dynamic-workflows-projection-fixture-capture.md`](design/dynamic-workflows-projection-fixture-capture.md)

Exit criteria:

- A host can render `.prose` execution progress, branch outputs, blocked calls, and final synthesis status.

## P4: Permission Policy Hardening

| Deliverable | Why | Status |
|---|---|---|
| Shell redirect model | Current tokenize-based parser does not model `> file` writes | Planned |
| Quote-aware operator splitting | Reduces fail-closed false positives | Planned |
| Framework tool allow/deny registry | Non-shell tools need explicit safety classification | Planned |
| Audit schema docs | Security analysis needs stable event fields | Planned |

Exit criteria:

- Known limitations in [`docs/fixes/runtime-guard-event-shape.md`](fixes/runtime-guard-event-shape.md) are either fixed or explicitly accepted with tests.

## P5: Model Routing & Thinking Intensity

Detailed design: [`docs/design/model-routing-thinking-intensity-design.md`](design/model-routing-thinking-intensity-design.md).

Two routing mechanisms that are **conditionally orthogonal**: non-interfering when autopilot `modelIds` is unset (`.prose` `model:` declarations fully win); autopilot tier **overrides** `.prose` `model:` when `modelIds` is configured and the run is active. See design §6.3–6.4 and the INT-3 open question in [`autopilot-dynamic-workflows-boundary.md`](design/autopilot-dynamic-workflows-boundary.md) §5.4.

| Deliverable | Why | Status |
|---|---|---|
| Graduated thinking intensity (3-level `effort-injection`) | Binary "use high effort" wastes reasoning time in validation phase; `resolveThinkingIntensity()` adapts per phase | Done 2026-06-29 (#33) |
| Model tier routing via `before_model_resolve` hook | `appendContext` is advisory-only; only `modelOverride` is consumed by Gateway | Done 2026-06-29 (#33) |
| `WORKFLOW.md` `model_routing` config parsing + tests | Per-phase tier + `modelIds` map parsed from WORKFLOW.md front-matter (snake_case); covered by `workflow-config.test.ts` L7 cases including nested `model_ids` | Done 2026-07-06 (#6ceb46a, L7) |
| `WORKFLOW.md` `model_routing` authoring guidance (agent-facing) | A skill/docs surface teaching agents when/how to declare `model_routing` — part of the autopilot skill/authoring layer (separate task) | Planned |
| Subagent routing (`subagentTier` + `isSubagentSession`) | Workflow subagents should route independently (e.g., screening on budget tier) | Done 2026-06-29 (#33; hook wiring covered by `before_model_resolve` e2e tests) |
| INT-3: child model intent vs parent `subagentTier` precedence | When both autopilot tier routing and a subagent's own model declaration exist, the child's declared model (`ctx.modelId`) wins; parent `subagentTier` is fallback for undeclared children | Done 2026-07-06 ([ADR-017](adr/017-int3-subagent-declared-model-wins.md)) |
| SKILL.md tier guidance for `.prose` generation | Map budget/standard/premium into agent-definition guidance so AI picks models systematically — benefits pure-workflow runs without autopilot | Planned (separate task; orthogonal to autopilot code) |

Exit criteria:

- `before_model_resolve` hook registered; returns `modelOverride` per execution phase for main agent and subagents.
- When `modelIds` is unconfigured, autopilot returns no override — `.prose` `model:` declarations fully win (no silent interference).
- `pnpm --filter @oh-my-matrix/autopilot test` remains green (667 existing tests unaffected; backward compat via `'high'` default).

## P6: Conditional Evidence Judging

Decision record: [`ADR-019`](adr/019-conditional-evidence-judging-boundary.md). Design: [`autopilot-conditional-judging-design.md`](design/autopilot-conditional-judging-design.md). Academic background: [`eb2ef245013a4216ad9eb1c2c0fb4c8d.md`](eb2ef245013a4216ad9eb1c2c0fb4c8d.md) (note: written for a different artifact; path inventory does not apply here).

Autopilot's judging capability is **conditional**, not universal: ground-truth completion judging applies only to tasks with verifiable validation commands. Model-level judging (independent Evaluator, adversarial prompts) is deferred — `runtime.llm.complete` with the default model is available without host opt-in, but mandates its own implementation ADR.

| Deliverable | Why | Status |
|---|---|---|
| Enhancement B: failure-signal injection into retry instructions | Model got "continue" with zero failure context after a failed validation; stderr re-surfaced (valuable post-compaction) | Done 2026-07-09 (#118) |
| Enhancement C: conditional `MIN_TURNS_BEFORE_COMPLETE` (2→3 for verifiable trusted) | Model could satisfy "all done" on turn 2 before validation ran, on the tasks where we *can* verify | Done 2026-07-09 (#119) |
| Enhancement A: re-run validation on `passed` before trusting it | Evidence can go stale between the gate check and run completion | Planned (touches `complete` branch timing) |
| `runtime.llm` default-model adversarial judging | Portable calibration technique (adversarial framing, ~15pp overconfidence reduction); available without host opt-in | Planned (needs own ADR + structured-JSON fallback design) |
| `runtime.subagent.run` ownership separation | True judgment-execution separation via isolated evaluator session | Planned (subagent capability boundary unverified) |

Exit criteria:

- Enhancements B/C shipped in 3.1.0; backward compatible (no change for runs without validation commands or `trustWorkspace`).
- ADR-016 sole-writer invariant preserved across all enhancements (no `status` writes; judging signals shape only the revise/complete branch condition).

## Historical v0.x Snapshot

The old roadmap phases for ralph/team/MCP/hooks/agent prompt libraries are historical. They remain useful for design archaeology only:

- [`docs/archive/adr/`](archive/adr/)
- [`docs/archive/contracts/`](archive/contracts/)
- [`docs/archive/plans/`](archive/plans/)
- [`docs/archive/reviews/`](archive/reviews/)

Do not update archived records to fit the current story. Add a new ADR or active roadmap item instead.
