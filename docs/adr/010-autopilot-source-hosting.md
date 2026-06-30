# ADR-010: Host the `@oh-my-matrix/autopilot` Source in omm

## Status

Accepted (2026-06-19).

## Context

[ADR-008](008-delegation-to-host.md) deleted omm's own `ralph`/`autopilot`/`goal` implementations and delegated autonomous loops to the host's `@oh-my-matrix/autopilot` plugin. That decision is about **not reimplementing** autopilot in omm — it says nothing about where the one canonical copy of `@oh-my-matrix/autopilot` source lives.

Before this ADR, `@oh-my-matrix/autopilot` lived inside a consuming host's plugin source tree and was integrated via a build script that compiled it and copied the output into the host's bundled-plugin directory. This build-script-copy pattern is a legacy coupling: the plugin source is entangled with the consuming app, and the copy step is a maintenance tax.

The plugin itself is fully self-contained — zero host-internal imports, a single `openclaw` peer dependency, a self-contained test suite (633 tests). It is portable by design.

## Decision

**Host the canonical `@oh-my-matrix/autopilot` source in omm at `packages/autopilot/`, making omm a pnpm monorepo. The host consumes the plugin as an offline npm package via `pnpm pack` + the `file:` protocol.**

This is **hosting, not reimplementation.** The decision strengthens ADR-008: there is now exactly one autopilot source in the whole stack (omm's `packages/autopilot/`), and the host consumes it as a package rather than owning a forked copy.

- omm becomes a pnpm workspace (`pnpm-workspace.yaml` → `packages/*`).
- `packages/autopilot/` holds source, 43 test files, `openclaw.plugin.json`, and a `pnpm pack` build.
- The host declares `"@oh-my-matrix/autopilot": "<a versioned file: tgz dependency>"` and bundles the tgz into its bundled-plugin directory, so the host is self-contained and does not depend on the sibling omm repo at install time.
- Plugin discovery in the host (the host's plugin-discovery module) resolves the plugin from `node_modules` (dev) and the host's bundled-plugin directory when packaged.

## Consequences

**Positive:**

- **Single source of truth.** One autopilot codebase; no drift between an app-embedded copy and any other consumer.
- **Host self-contained.** The tgz is vendored into `resources/autopilot/`, so a fresh host clone installs without the omm repo present.
- **omm positioned as the OpenClaw-plugin hosting monorepo.** Future shared plugins (team orchestration, employee-bridge) can live alongside autopilot under `packages/`.
- **ADR-008 reinforced, not contradicted.** omm does not reimplement autopilot; it hosts the canonical copy that the host runs.

**Negative:**

- **Distribution ceremony.** A source change requires `pnpm build && pnpm pack` in omm, then copying the new tgz into the host's `resources/autopilot/` and bumping the version in the host's `package.json`. CI automation is a future improvement.
- **Two repos must stay in sync.** A change to autopilot source in omm is invisible to the host until the tgz is refreshed. The version in the tgz filename is the contract.

## Follow-ups

1. **Automate the tgz refresh.** A script or CI step that rebuilds and copies the tgz on autopilot source change.
2. **Optional npm publish.** If a second consumer appears, publish `@oh-my-matrix/autopilot` to a registry and replace the `file:` dependency with a versioned one.

## Related ADRs

- **ADR-008** — delegation to host. This ADR is compatible: hosting the canonical source is orthogonal to not reimplementing it.
