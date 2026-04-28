# omm Architecture Overview

> oh-my-matrix (omm) v0.2.0 — OpenClaw-native orchestration extension suite

## Project Positioning

omm provides persistent workflow capabilities (ralph/autopilot/team) for any OpenClaw-compatible host.
It is modeled after [oh-my-codex](https://github.com/anthropics/oh-my-codex) but redesigned as a **pure plugin** — no standalone CLI, no Rust native modules, zero runtime dependencies.

| Dimension          | oh-my-codex                    | omm                                     |
| ------------------ | ------------------------------ | --------------------------------------- |
| Runtime            | Standalone CLI (`omx`)         | OpenClaw plugin loaded by Gateway       |
| Team parallelism   | Self-built tmux + git worktree | Delegates to host team skill            |
| MCP implementation | `@modelcontextprotocol/sdk`    | Hand-written JSON-RPC (zero-dependency) |
| Distribution       | npm binary + 4 Rust crates     | Single tarball, JS-only                 |

See [ADR-001](/reference/adrs/001), [ADR-002](/reference/adrs/002), [ADR-003](/reference/adrs/003) for rationale.

## Module Decomposition

```
omm-packages/
├── omm-plugin/     OpenClaw plugin — tools, hooks, state validation
├── omm-mcp/        Stdio JSON-RPC MCP server for out-of-process state access
└── omm-skills/     SKILL.md definitions for workflow modes
```

### omm-plugin

The plugin entry point `register(api)` conforms to the OpenClaw Plugin ABI:

- **5 tools** registered via `api.registerTool()`: `omm_ping`, `omm_cancel`, `omm_state_write`, `omm_state_read`, `omm_state_list`
- **2 lifecycle hooks** registered via `api.on()`: `session_start`, `session_end`
- All tools are `{ optional: true }` — the host functions without omm

Key modules:

| Module                    | Responsibility                                                |
| ------------------------- | ------------------------------------------------------------- |
| `omm-register.ts`         | Plugin entry point; wires tools and hooks to the OpenClaw API |
| `omm-state-validation.ts` | Mode-aware state validation for ralph/autopilot/team          |
| `omm-config.ts`           | Resolves state root directory; defaults to `~/.openclaw/omm`  |
| `omm-state.ts`            | Smoke record writer for session lifecycle events              |
| `omm-tools/omm-state.ts`  | State read/write/list tools with atomic persistence           |
| `omm-tools/omm-ping.ts`   | Health-check tool                                             |
| `omm-tools/omm-cancel.ts` | Session cancellation tool                                     |

### omm-mcp

A standalone stdio JSON-RPC server implementing MCP protocol 2024-11-05. Exposes the same three state tools (`read`, `write`, `list`) over stdio transport, enabling out-of-process access from any MCP client.

Inlines a simplified copy of the validation logic from `omm-state-validation.ts` to maintain zero cross-package dependencies.

See [ADR-003](/reference/adrs/003) and [MCP Protocol Contract](/reference/contracts/mcp-protocol).

### omm-skills

Five SKILL.md files define workflow behaviors:

| Skill           | Type          | State Machine                                                                          |
| --------------- | ------------- | -------------------------------------------------------------------------------------- |
| `omm-ping`      | Tool dispatch | Direct `omm_ping` call                                                                 |
| `omm-cancel`    | Tool dispatch | Direct `omm_cancel` call                                                               |
| `omm-ralph`     | Model-driven  | INIT → PLANNING → EXECUTING → VERIFYING ↔ FIXING → COMPLETE/FAILED                     |
| `omm-autopilot` | Model-driven  | ANALYZING → PLANNING → STEP_N → VERIFYING ↔ RETRY → COMPLETE/BLOCKED/FAILED            |
| `omm-team`      | Model-driven  | PLANNING → DECOMPOSING → DELEGATING → EXECUTING → VERIFYING ↔ FIXING → COMPLETE/FAILED |

See [ADR-004](/reference/adrs/004) and [Workflow State Contract](/reference/contracts/workflow-state).

## Data Flow

### State Write Path

```
Tool call (omm_state_write)
  → Input validation (key required, value is object)
  → Mode-aware validation (validateStateWrite)
    → Route by mode: value.mode ?? key
    → Known modes: enforce phase set, counter invariants, terminal rules
    → Unknown keys: pass through with timestamp
  → Atomic persistence (writeFile tmp → rename)
  → Response to caller
```

### Dual-Access Model

The same state directory (`{stateRoot}/state/`) is accessible via two paths:

1. **In-process**: OpenClaw plugin tools — used during normal skill execution
2. **Out-of-process**: MCP server over stdio — used by external MCP clients

Both paths apply validation before writing. The MCP server inlines equivalent validation logic.

See [State Contract](/reference/contracts/state-contract).

## Host Boundary

### What omm owns

- State persistence and validation
- Workflow skill definitions (SKILL.md lifecycle instructions)
- Build and compliance toolchain

### What the host provides

- **OpenClaw Gateway**: Plugin loading, tool dispatch, skill execution engine
- **Team parallelism**: `TeamCreate`/`TaskCreate`/`SendMessage` for parallel workers
- **Skill runtime**: Model invocation, SKILL.md interpretation, frontmatter processing
- **Consumer integration**: Tarball unpacking, config injection at startup

### Consumer Integration

The primary consumer (MatrixAssistant) integrates omm via:

1. `omm-build-suite.mjs` produces `omm-suite-<version>.tgz` with SHA-256 manifest
2. `scripts/omm-bundle.mjs` unpacks and verifies the tarball into `resources/`
3. `electron/utils/omm-openclaw-seed.ts` injects omm config into `openclaw.json` at startup
4. OpenClaw Gateway discovers the plugin and skills automatically

## Extension Points

| Extension            | How                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Add a new tool       | Create handler in `omm-tools/`, register in `omm-register.ts`, add to consumer whitelist |
| Add a new skill      | Create `omm-skills/<name>/SKILL.md`, bundle includes it automatically                    |
| Add a new state mode | Add validator function in `omm-state-validation.ts`, add to `VALIDATORS` map             |
| Add a lifecycle hook | Register via `api.on()` in `omm-register.ts`                                             |

## Build and Compliance

| Script                      | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `omm-build-suite.mjs`       | Stage + tarball with SHA-256 manifest           |
| `omm-scan-names.mjs`        | Hash-based forbidden name denylist scan         |
| `omm-verify-bundle.mjs`     | Tarball integrity verification against manifest |
| `omm-verify-provenance.mjs` | Provenance metadata validation                  |

CI pipeline (`.gitlab-ci.yml`): install → build → test → lint → scan-names → verify-provenance → verify-bundle

## Test Strategy

- Framework: `node:test` (zero dependencies)
- Co-located test files: `*.test.ts` alongside source
- 25 test cases covering: state validation (17), state tools (8), ping, cancel
- Tests run against compiled JS: `node --test omm-packages/omm-plugin/dist/src/**/*.test.js`
