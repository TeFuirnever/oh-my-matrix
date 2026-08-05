# Fix Spec: Autopilot Config-Reload Contract (`trustWorkspace` stale-config investigation)

> **Status: DONE (no production code change) — documented + regression-tested.**
> Outcome of a 4-reviewer adversarial review + 3 verification agents. The
> originally reported "stale config on attach-to-existing-gateway" bug is largely
> non-existent in steady state because the gateway already self-heals via its
> `plugins` hot-reload rule. Every code-level fix proposed was either redundant
> or a regression. This doc records the contract and the trap so it isn't
> re-litigated.
>
> **Anchor note (2026-08-05):** version cite below updated to `openclaw@2026.7.1-2`. The
> dist-hash evidence chain (`dist/server-reload-handlers-4pMoRutv.js`, …) was captured
> against `2026.5.28`; bundle hashes change every build, so the `register()` re-invocation
> contract must be re-verified against `2026.7.1-2` dist before relying on it anew.

## The reported bug (and why it's mostly a non-bug)

The original analysis: autopilot freezes `trustWorkspace` from `api.pluginConfig`
into a closure `const config` during `register()`, and the activate handler
(`packages/autopilot/index.ts:1191`) reads `config.trustWorkspace`. The claim was
that this value is **frozen for the process lifetime** and never re-read, so when
a client attaches to an already-running gateway G1 (spawned before
`trustWorkspace:true` was written to `openclaw.json`), the activate handler keeps
serving the stale `false`.

The first part is true (`config` is a `const` inside `register()`). The "never
re-read for the process lifetime" part is **false**.

## The self-heal (verified against the SDK)

OpenClaw (`openclaw@2026.7.1-2`) re-invokes the plugin's `register()` on every
autopilot config change. The chain, with evidence:

1. **chokidar watcher** on `openclaw.json`
   (`dist/server-reload-handlers-4pMoRutv.js:239`,
   `awaitWriteFinish.stabilityThreshold:200` + `pollInterval:50`) → debounced
   `runReload()` (`debounceMs:300`, `dist/config-reload-settings-BCSjTPm-.js:4`).
2. `runReload` → `applySnapshot` → `buildGatewayReloadPlan`
   (`dist/config-reload-plan-2JVNNzmM.js:350-372`).
3. **Rule match:** path `plugins.entries.autopilot.config.trustWorkspace` matches
   the bare `plugins` tail rule (`config-reload-plan-2JVNNzmM.js:188-192`):
   `{prefix:"plugins", kind:"hot", actions:["reload-plugins","dispose-mcp-runtimes"]}`.
   Autopilot is not a channel plugin, so no `channelPluginStateRules` entry
   applies; the bare rule wins.
4. `applyHotReload` (`server-reload-handlers-4pMoRutv.js:422-465`) calls
   `params.reloadPlugins({nextConfig, ...})` → `reloadAttachedGatewayPlugins`
   (`server.impl-DeT2SF6w.js:2545`).
5. `reloadAttachedGatewayPlugins` → `prepareGatewayPluginLoad` →
   `loadOpenClawPlugins` → **`runPluginRegisterSync(register, api)`**
   (`loader-wybWjJVr.js:6559`), with a **fresh `api`** whose `pluginConfig`
   (`loader-wybWjJVr.js:6538-6543`) is sourced from `entry.config` of the
   just-reloaded `openclaw.json` (validated against the plugin schema at
   `loader-wybWjJVr.js:6223-6227`).
6. **Old handlers disposed:** `replaceAttachedPluginRuntime`
   (`server.impl-DeT2SF6w.js:2162-2172`) clears old gateway-method handlers
   (`:2165`) and assigns the new registry's `gatewayHandlers`; old plugin
   services are stopped (`:2249`). No double-registration.

Net: `register()` re-runs with a fresh `api.pluginConfig`, the `const config`
(`packages/autopilot/index.ts:467`) is **re-frozen**, and the activate handler
registered by the new `register()` closes over the fresh value. The
`config.trustWorkspace` read at `index.ts:1191` is therefore correct ~500ms
after the external write.

The same schema-validation that guards the register-time `pluginConfig` also
guards the reload path (`validatePluginConfig` at `loader-wybWjJVr.js:6223`), so
the live value cannot be a type-coerced `true` (a non-boolean is rejected →
`handleInvalidSnapshot` keeps the last-good snapshot). TOCTOU / partial-write is
rejected the same way (`io-By9euW-h.js:4592-4608` returns `valid:false` →
`handleInvalidSnapshot` early-returns without touching the snapshot).

## The ~500ms reload window (residual, accepted)

`200ms` (chokidar `stabilityThreshold`) + `300ms` (reload `debounceMs`) ≈
**500ms** between an external `openclaw.json` write and `register()` re-running.
An `autopilot.activate` landing in that window sees the stale value for that one
turn. Accepted per project decision. Closing it deterministically would require
either:

- **MA-side** `await ensureAutopilotTrustWorkspaceConfig()` before
  `gatewayManager.start()` on the attach path (out of this repo), or
- **SDK change** so plugins can declare a hot rule that explicitly carries
  `reload-plugins` (see the feature request below) — though even a declared rule
  still races the same watcher window; the deterministic fix is MA-side.

## Why no `registerReload` declaration is made (the trap)

The SDK exposes `api.registerReload({restartPrefixes?, hotPrefixes?, noopPrefixes?})`
(`dist/plugin-sdk/types-B4TJD_iZ.d.ts:7036`, type `:6670-6674`). We evaluated
declaring reload intent and found **every variant is worse than today**:

| Declaration | Effect on `plugins.entries.autopilot.config.*` | Verdict |
|---|---|---|
| *(none — status quo)* | bare `plugins` rule → `reload-plugins` → re-`register()` | ✅ self-heals |
| `hotPrefixes:['plugins.entries.autopilot']` | rule `{prefix, kind:"hot"}` with **no `actions`** is inserted **before** `BASE_RELOAD_RULES_TAIL` (`config-reload-plan:238-254`); first-match-wins (`:258-261`) → action-less hot rule shadows the bare rule → `reload-plugins` **never fires** → `register()` **stops** re-running | ❌ **regression** |
| `restartPrefixes:['plugins.entries.autopilot.config']` | `kind:"restart"` → `plan.restartGateway=true` → SIGUSR1 → supervisor respawns G1 on **every** config edit | ❌ operational regression |
| `noopPrefixes:[...]` | suppresses all actions | ❌ regression |

Root cause of the trap: `OpenClawPluginReloadRegistration` has **no `actions`
field** — a plugin cannot declare a hot rule that explicitly carries
`reload-plugins`. Only channel plugins get that auto-grant
(`channelPluginStateRules`, `config-reload-plan:229-237`), and only via
`registerChannel`, which autopilot is not. So in this SDK version there is no
clean way to make the contract explicit without weakening it.

## What we shipped instead

1. **Contract comment** at `packages/autopilot/index.ts` (above the `api.pluginConfig`
   read in `register()`) documenting that `config` is intentionally re-derived
   per-`register()` and must not be hoisted to module scope.
2. **Regression test** `tests/e2e/workflow-config-roundtrip.e2e.test.ts`
   ("reload contract: re-register() ...") that re-runs `register()` with fresh
   `pluginConfig.trustWorkspace` and asserts the activate handler reflects the
   new value, plus that the `payload ?? config ?? false` precedence chain
   survives the reload. Models the gateway hot-reload faithfully (the gateway
   literally re-calls `register()`), not an `api.runtime` mock.
3. This doc.

No production code change. No version bump (3.0.2 stays — no behavior/API change).

## SDK feature request (out of this repo, non-blocking)

File against the OpenClaw SDK: extend `OpenClawPluginReloadRegistration`
(`types-B4TJD_iZ.d.ts:6670-6674`) and the manifest `reload` field to accept an
optional `actions?: string[]` (or a richer per-prefix rule object), so a plugin
can declare
`{prefix:'plugins.entries.autopilot', kind:'hot', actions:['reload-plugins']}`
explicitly rather than relying on the implicit bare-rule fallback. Today the
generated plugin rule carries no `actions` (`config-reload-plan:238-247`), which
makes `hotPrefixes` a footgun for any plugin whose self-heal currently depends on
the bare `plugins` tail rule.

## Verification

- `cd packages/autopilot && pnpm test` — passes, including the new reload-contract test.
- `cd packages/autopilot && pnpm typecheck` — passes (comment-only + test-only).
- `corepack pnpm -r test && corepack pnpm -r typecheck` — workspace gate green.

## Adversarial-review traceability

This conclusion is the synthesis of 4 adversarial reviewers (Security Adversary,
Runtime-Contract Skeptic, Test-Quality Auditor, Scope & Completeness Critic) and
3 verification agents. Refuted claims of note: TOCTOU / partial-write →
`handleInvalidSnapshot` rejects corrupt parses; type-coercion bypass → schema
validation runs on the reload path too; the `api.runtime.config.current()`
live-read linchpin → correct but irrelevant (register itself is re-run); the
`registerReload` recommendation → a trap in this SDK version.
