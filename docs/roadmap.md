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
| Package refresh contract for MatrixAssistant/OpenClaw | Keeps vendored/bundled plugin copies auditable | Planned |

Exit criteria:

- A maintainer can rebuild `autopilot`, `dynamic-workflows`, and `permission-policy`, refresh the host copy, restart the gateway, and prove the loaded dist matches source.

## P2: Autopilot Release Readiness

| Deliverable | Why | Status |
|---|---|---|
| Public package policy | Packages are private today; users need clear install story | Planned |
| `WORKFLOW.md` examples | Autopilot config exists but needs copy-pasteable examples | Planned |
| Projection contract docs | Host UI needs stable fields and failure semantics | Planned |
| Public type exports (`AutopilotProjection` from barrel) | Hosts deep-import `dist/src/projection` today, coupling to OMM's internal layout | Planned |
| Evidence gate examples | Users need to understand required vs optional validation | Planned |

Exit criteria:

- Autopilot has a documented integration path, config examples, and host UI contract.
- Public types (`AutopilotProjection`) exported from the package barrel; no consumer reaches into `dist/src/`.
- `pnpm --filter @oh-my-matrix/autopilot test` remains green.

## P3: Dynamic Workflows Observability

| Deliverable | Why | Status |
|---|---|---|
| Workflow graph contract | Large fan-out runs need visible branch state | Planned |
| Blocked-call reporting | Guard blocks should be understandable, not mysterious | Planned |
| Pattern examples gallery | The 8 workflow modes need realistic examples | Planned |

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

## Historical v0.x Snapshot

The old roadmap phases for ralph/team/MCP/hooks/agent prompt libraries are historical. They remain useful for design archaeology only:

- [`docs/archive/adr/`](archive/adr/)
- [`docs/archive/contracts/`](archive/contracts/)
- [`docs/archive/plans/`](archive/plans/)
- [`docs/archive/reviews/`](archive/reviews/)

Do not update archived records to fit the current story. Add a new ADR or active roadmap item instead.
