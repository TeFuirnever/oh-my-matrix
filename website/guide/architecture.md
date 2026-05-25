# omm Architecture Overview

> oh-my-matrix (omm) v0.4.2 — OpenClaw-native orchestration extension suite

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
├── omm-mcp/        Stdio JSON-RPC MCP server for workflow state + prompts
├── omm-mcp-memory/ Stdio JSON-RPC MCP server for key-value memory
├── omm-mcp-trace/  Stdio JSON-RPC MCP server for execution traces
└── omm-skills/     SKILL.md definitions for workflow and artifact modes
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

### omm-mcp / omm-mcp-memory / omm-mcp-trace

Three standalone stdio JSON-RPC servers implement MCP protocol 2024-11-05:

- `omm-mcp` exposes workflow state tools (`read`, `write`, `list`), Resources, and Prompts.
- `omm-mcp-memory` exposes persistent key-value memory tools.
- `omm-mcp-trace` exposes trace record/query/list/metrics tools and trace Resources.

`omm-mcp` inlines a simplified copy of the validation logic from `omm-state-validation.ts` to maintain zero cross-package dependencies.

See [ADR-003](/reference/adrs/003) and [MCP Protocol Contract](/reference/contracts/mcp-protocol).

### omm-skills

Fourteen packaged SKILL.md directories define workflow and artifact behaviors:

| Skill                | Type                  | Purpose                                                                                |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| `omm-ping`           | Tool dispatch         | Direct `omm_ping` call                                                                 |
| `omm-cancel`         | Tool dispatch         | Direct `omm_cancel` call                                                               |
| `omm-ralph`          | Model-driven workflow | INIT → PLANNING → EXECUTING → VERIFYING ↔ FIXING → COMPLETE/FAILED                     |
| `omm-autopilot`      | Model-driven workflow | ANALYZING → PLANNING → STEP_N → VERIFYING ↔ RETRY → COMPLETE/BLOCKED/FAILED            |
| `omm-team`           | Model-driven workflow | PLANNING → DECOMPOSING → DELEGATING → EXECUTING → VERIFYING ↔ FIXING → COMPLETE/FAILED |
| `omm-deep-interview` | Model-driven workflow | Requirements interview with explicit ambiguity gates                                   |
| `omm-ralplan`        | Model-driven workflow | Consensus planning and test-shape review                                               |
| `omm-ultrawork`      | Model-driven workflow | Parallel execution planning over host-provided team primitives                         |
| `omm-ultraqa`        | Model-driven workflow | QA cycle that tests, verifies, fixes, and repeats until the target is met               |
| `omm-docs`           | Artifact workflow     | Documentation generation pipeline                                                      |
| `omm-ui`             | Artifact workflow     | UI artifact generation pipeline                                                        |
| `omm-git`            | History workflow      | Atomic commits, style detection, and safe branch hygiene                               |
| `omm-research`       | Artifact workflow     | Evidence-backed local research and metrics analysis                                    |
| `omm-refactor`       | Artifact workflow     | Behavior-preserving simplification pipeline                                            |

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

The same workflow state directory (`{stateRoot}/state/`) is accessible via two paths:

1. **In-process**: OpenClaw plugin tools — used during normal skill execution
2. **Out-of-process**: MCP server over stdio — used by external MCP clients

Both paths apply validation before writing. The state MCP server inlines equivalent validation logic. Memory and trace data are exposed by dedicated MCP servers under the same configured OMM root.

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

1. `omm-scripts/omm-build-suite.mjs` produces `omm-suite-<version>.tgz` with SHA-256 manifest
2. `omm-scripts/omm-verify-bundle.mjs` verifies tarball integrity against the manifest
3. `omm-scripts/omm-openclaw-seed.mjs` injects omm plugin config into `~/.openclaw/openclaw.json`
4. OpenClaw Gateway discovers the plugin and skills automatically
5. `omm-scripts/omm-ma-seed.mjs` registers the three stdio MCP servers in MA's MCP registry

## Extension Points

| Extension            | How                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Add a new tool       | Create handler in `omm-tools/`, register in `omm-register.ts`, add to consumer whitelist |
| Add a new skill      | Create `omm-skills/<name>/SKILL.md`, add it to `SHIPPED_SKILLS` in `omm-build-suite.mjs` |
| Add a new state mode | Add validator function in `omm-state-validation.ts`, add to `VALIDATORS` map             |
| Add a lifecycle hook | Register via `api.on()` in `omm-register.ts`                                             |

## Build and Compliance

| Script                      | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `omm-build-suite.mjs`       | Stage + tarball with SHA-256 manifest           |
| `omm-scan-names.mjs`        | Hash-based forbidden name denylist scan         |
| `omm-verify-bundle.mjs`     | Tarball integrity verification against manifest |
| `omm-verify-provenance.mjs` | Provenance metadata validation                  |
| `omm-smoke-mcp.mjs`         | MCP wire-contract smoke test                    |
| `omm-ma-seed.mjs`           | MatrixAssistant MCP registry seeder             |
| `omm-openclaw-seed.mjs`     | OpenClaw plugin registry seeder                 |

CI pipeline (`.gitlab-ci.yml`): install → build → test → lint → scan-names → verify-provenance → verify-bundle

## Test Strategy

- Framework: `node:test` (zero dependencies)
- Script tests under `omm-scripts/*.test.mjs` plus compiled package tests
- 411 tests covering plugin tools/state, workflow lifecycle, MCP state/memory/trace, Resources/Prompts, seeders, and bundle/package checks
- Full suite: `pnpm test`
