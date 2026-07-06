# ADR-010: Host the `@oh-my-matrix/autopilot` Source in omm

## Status

Accepted (2026-06-19). **Updated 2026-07-06**: npm registry publishing is now
the primary distribution path (Follow-up #2 closed); the offline `file:` tgz
path remains as a host-vendoring option, not the sole channel. See the
"Decision" and "Follow-ups" sections below.

## Context

[ADR-008](008-delegation-to-host.md) deleted omm's own `ralph`/`autopilot`/`goal` implementations and delegated autonomous loops to the host's `@oh-my-matrix/autopilot` plugin. That decision is about **not reimplementing** autopilot in omm — it says nothing about where the one canonical copy of `@oh-my-matrix/autopilot` source lives.

Before this ADR, `@oh-my-matrix/autopilot` lived inside a consuming host's plugin source tree and was integrated via a build script that compiled it and copied the output into the host's bundled-plugin directory. This build-script-copy pattern is a legacy coupling: the plugin source is entangled with the consuming app, and the copy step is a maintenance tax.

The plugin itself is fully self-contained — zero host-internal imports, a single `openclaw` peer dependency, a self-contained test suite (633 tests). It is portable by design.

## Decision

**Host the canonical `@oh-my-matrix/autopilot` source in omm at `packages/autopilot/`, making omm a pnpm monorepo. Distribute via the npm registry as the primary path; the host may additionally vendor a tgz for offline self-containment.**

This is **hosting, not reimplementation.** The decision strengthens ADR-008: there is now exactly one autopilot source in the whole stack (omm's `packages/autopilot/`), and consumers reach it as a package rather than owning a forked copy.

- omm becomes a pnpm workspace (`pnpm-workspace.yaml` → `packages/*`).
- `packages/autopilot/` holds source, 43 test files, `openclaw.plugin.json`, and a `pnpm pack` build.
- **Primary distribution (since the release pipeline landed):** the three `@oh-my-matrix/*` packages are published to the npm registry via Changesets + `scripts/publish.sh` (see CONTRIBUTING.md § Releasing). Any consumer declares `"@oh-my-matrix/autopilot": "^3.0.0"` and installs from the registry.
- **Offline host-vendoring option (the original channel):** a host that must be self-contained at install time may instead declare `"@oh-my-matrix/autopilot": "<a versioned file: tgz dependency>"` and bundle the tgz into its bundled-plugin directory. This is now an *option*, not *the* channel.
- Plugin discovery in the host (the host's plugin-discovery module) resolves the plugin from `node_modules` (dev) and the host's bundled-plugin directory when packaged.

## Consequences

**Positive:**

- **Single source of truth.** One autopilot codebase; no drift between an app-embedded copy and any other consumer.
- **Host self-contained.** The tgz is vendored into `resources/autopilot/`, so a fresh host clone installs without the omm repo present.
- **omm positioned as the OpenClaw-plugin hosting monorepo.** Future shared plugins (team orchestration, employee-bridge) can live alongside autopilot under `packages/`.
- **ADR-008 reinforced, not contradicted.** omm does not reimplement autopilot; it hosts the canonical copy that the host runs.

**Negative:**

- **Host-vendoring ceremony (only for hosts that choose the offline tgz path).** A source change requires `pnpm build && pnpm pack` in omm, then copying the new tgz into the host's `resources/autopilot/` and bumping the version in the host's `package.json`. **For registry consumers this cost is gone** — a version bump in the consumer's `package.json` suffices.
- **Two repos must stay in sync (only for offline-vendoring hosts).** A change to autopilot source in omm is invisible to a vendoring host until its tgz is refreshed. **Registry consumers see the new version as soon as `publish.sh` runs.** The version in the tgz filename (offline) or the npm semver (registry) is the contract.

## Follow-ups

1. **Done — automated versioning via Changesets.** The Release GitHub Action (`.github/workflows/release.yml`) opens a "Version Packages" PR on every master push when changesets are pending. `scripts/publish.sh` performs the manual npm publish with pre-flight validation and post-publish verification. See CONTRIBUTING.md § Releasing.
2. **Done — npm registry publishing.** All three `@oh-my-matrix/*` packages are published to the npm registry with `publishConfig: { access: "public" }`. The original "if a second consumer appears" condition is satisfied: any consumer can now `npm install @oh-my-matrix/autopilot`. The offline `file:` tgz path remains available for hosts that need install-time self-containment.

## Related ADRs

- **ADR-008** — delegation to host. This ADR is compatible: hosting the canonical source is orthogonal to not reimplementing it.
