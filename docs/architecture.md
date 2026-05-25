# omm Architecture Overview

> oh-my-matrix (omm) v0.4.2 — OpenClaw-native orchestration extension suite（OpenClaw 原生编排扩展套件）

## Project Positioning

omm provides persistent workflow capabilities (ralph/autopilot/team) for any OpenClaw-compatible host.
It is modeled after [oh-my-codex](https://github.com/anthropics/oh-my-codex) but redesigned as a **pure plugin** — no standalone CLI, no Rust native modules, zero runtime dependencies.

| Dimension          | oh-my-codex                    | omm                                      |
| ------------------ | ------------------------------ | ---------------------------------------- |
| Runtime            | Standalone CLI (`omx`)         | OpenClaw plugin loaded by Gateway        |
| Team parallelism   | Self-built tmux + git worktree | Delegates to host team skill（委托宿主） |
| MCP implementation | `@modelcontextprotocol/sdk`    | Hand-written JSON-RPC（零依赖）          |
| Distribution       | npm binary + 4 Rust crates     | Single tarball, JS-only                  |

See [ADR-001](adr/001-pure-plugin-no-cli.md), [ADR-002](adr/002-team-delegation-to-host.md), [ADR-003](adr/003-zero-dependency-mcp.md) for rationale.

## Module Decomposition

```
omm-packages/
├── omm-plugin/     OpenClaw plugin — tools, hooks, state validation
├── omm-mcp/        Stdio JSON-RPC MCP server for workflow state + prompts
├── omm-mcp-memory/ Stdio JSON-RPC MCP server for key-value memory
├── omm-mcp-trace/  Stdio JSON-RPC MCP server for execution traces
└── omm-skills/     SKILL.md definitions for workflow and artifact modes
```

### omm-plugin（插件核心）

The plugin entry point `register(api)` conforms to the OpenClaw Plugin ABI:

- **5 tools** registered via `api.registerTool()`: `omm_ping`, `omm_cancel`, `omm_state_write`, `omm_state_read`, `omm_state_list`
- **2 lifecycle hooks** registered via `api.on()`: `session_start`, `session_end`
- All tools are `{ optional: true }` — the host functions without omm

Key modules:

| Module                    | Responsibility                                                        |
| ------------------------- | --------------------------------------------------------------------- |
| `omm-register.ts`         | Plugin entry point; wires tools and hooks to the OpenClaw API         |
| `omm-state-validation.ts` | Mode-aware state validation（三模式状态验证）for ralph/autopilot/team |
| `omm-config.ts`           | Resolves state root directory; defaults to `~/.openclaw/omm`          |
| `omm-state.ts`            | Smoke record writer for session lifecycle events                      |
| `omm-tools/omm-state.ts`  | State read/write/list tools with atomic persistence                   |
| `omm-tools/omm-ping.ts`   | Health-check tool                                                     |
| `omm-tools/omm-cancel.ts` | Session cancellation tool                                             |

### omm-mcp / omm-mcp-memory / omm-mcp-trace（MCP 服务器）

Three standalone stdio JSON-RPC servers implement MCP protocol 2024-11-05:

- `omm-mcp` exposes workflow state tools (`read`, `write`, `list`), Resources, and Prompts.
- `omm-mcp-memory` exposes persistent key-value memory tools.
- `omm-mcp-trace` exposes trace record/query/list/metrics tools and trace Resources.

`omm-mcp` inlines a simplified copy of the validation logic from `omm-state-validation.ts` to maintain zero cross-package dependencies.

See [ADR-003](adr/003-zero-dependency-mcp.md) and [MCP Protocol Contract](contracts/mcp-protocol-contract.md).

### omm-skills（技能定义）

Five core skills are shipped in the suite tarball. Nine extended skills remain in `omm-packages/omm-skills/` but are excluded from packaging to focus MA integration testing on the core workflow engine.

**Shipped（5 core）:**

| Skill           | Type                    | Purpose                                                                                 |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `omm-ping`      | Tool dispatch（无模型） | Direct `omm_ping` call                                                                  |
| `omm-cancel`    | Tool dispatch（无模型） | Direct `omm_cancel` call                                                                |
| `omm-ralph`     | Model-driven workflow   | INIT → PLANNING → EXECUTING → VERIFYING ↔ FIXING → COMPLETE/FAILED                      |
| `omm-autopilot` | Model-driven workflow   | ANALYZING → PLANNING → STEP_N → VERIFYING ↔ RETRY → COMPLETE/BLOCKED/FAILED             |
| `omm-team`      | Model-driven workflow   | PLANNING → DECOMPOSING → DELEGATING → EXECUTING → VERIFYING ↔ FIXING → COMPLETE/FAILED  |

**Parked（9 extended, not in suite tarball）:**

`omm-deep-interview`, `omm-ralplan`, `omm-ultrawork`, `omm-ultraqa`, `omm-docs`, `omm-ui`, `omm-git`, `omm-research`, `omm-refactor`

See [ADR-004](adr/004-three-mode-state-machine.md) and [Workflow State Contract](contracts/workflow-state-contract.md).

## Data Flow

### State Write Path（状态写入路径）

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

### Dual-Access Model（双通道访问）

The same workflow state directory (`{stateRoot}/state/`) is accessible via two paths:

1. **In-process**: OpenClaw plugin tools — used during normal skill execution
2. **Out-of-process**: MCP server over stdio — used by external MCP clients

Both paths apply validation before writing. The state MCP server inlines equivalent validation logic. Memory and trace data are exposed by dedicated MCP servers under the same configured OMM root.

See [State Contract](contracts/state-contract.md).

## Host Boundary（宿主边界）

### What omm owns

- State persistence and validation
- Workflow skill definitions (SKILL.md lifecycle instructions)
- Build and compliance toolchain

### What the host provides

- **OpenClaw Gateway**: Plugin loading, tool dispatch, skill execution engine
- **Team parallelism**: `TeamCreate`/`TaskCreate`/`SendMessage` for parallel workers
- **Skill runtime**: Model invocation, SKILL.md interpretation, frontmatter processing
- **Consumer integration**: Tarball unpacking, config injection at startup

### Consumer Integration（消费者集成）

The primary consumer (MatrixAssistant) integrates omm via:

1. `omm-scripts/omm-build-suite.mjs` produces `omm-suite-<version>.tgz` with SHA-256 manifest
2. `omm-scripts/omm-verify-bundle.mjs` verifies tarball integrity against the manifest
3. `omm-scripts/omm-openclaw-seed.mjs` injects omm plugin config into `~/.openclaw/openclaw.json`
4. OpenClaw Gateway discovers the plugin and skills automatically
5. `omm-scripts/omm-ma-seed.mjs` registers the three stdio MCP servers in MA's MCP registry; see [`contracts/ma-integration-snippets.md`](contracts/ma-integration-snippets.md)

## Extension Points（扩展点）

| Extension            | How                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Add a new tool       | Create handler in `omm-tools/`, register in `omm-register.ts`, add to consumer whitelist |
| Add a new skill      | Create `omm-skills/<name>/SKILL.md`, add it to `SHIPPED_SKILLS` in `omm-build-suite.mjs` |
| Add a new state mode | Add validator function in `omm-state-validation.ts`, add to `VALIDATORS` map             |
| Add a lifecycle hook | Register via `api.on()` in `omm-register.ts`                                             |

## Build and Compliance（构建与合规）

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
