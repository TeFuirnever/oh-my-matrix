<!-- Generated: 2026-05-12 -->

# MA Integration Snippets — omm MCP Servers

> Drop-in JSON snippets for registering omm's 3 MCP servers into MatrixAssistant (MA), without modifying any MA source code. These snippets satisfy MA's `ScopeLoader` schema exactly as of `electron/main/services/mcp/registry/scope-loader.ts` and `electron/main/services/mcp/schemas.ts` at commit-time of this doc.
>
> Cross-references:
> - [`mcp.md`](./mcp.md) — omm MCP URI scheme and capability matrix
> - [`mcp-protocol-contract.md`](./mcp-protocol-contract.md) — JSON-RPC wire format
> - [`../architecture.md`](../architecture.md) §"Consumer Integration" — how MA unpacks the tarball

---

## Audience

You are a MatrixAssistant user (or omm-bundle script) who wants MA's built-in MCP client to discover and consume omm's three MCP servers — `omm-state`, `omm-memory`, `omm-trace` — so that MA's UI can list omm Resources (`omm://state/<key>`, `omm://trace/<sessionId>`, `omm://prompts/<name>`) end-to-end.

This is the omm-side artifact that closes the Phase 4 exit "MA UI confirmed to consume omm Resources end-to-end" (see `docs/roadmap.md`).

---

## MA's 4 Config Scopes (read-only reference)

MA's `McpRegistry` reads 4 scopes in this precedence (later overrides earlier when names collide):

| Scope | Path | Writable by omm tarball install? |
|-------|------|----------------------------------|
| `managed` | `<MA-install>/resources/mcp/mcporter-default-config.json` | **No** — app-bundled, MA-team-owned |
| `user` | `~/.matrixassistant/mcporter/mcporter.json` | Yes (per-user) |
| `project` | `<workspace>/.matrixassistant/mcp.json` | Yes (per-workspace) |
| `local` | `<workspace>/.mcp.local.json` | Yes (per-workspace, gitignored) |

omm targets **`user`**, **`project`**, or **`local`** — never `managed`. The `managed` scope uses a permissive `ManagedServerSpecSchema` that allows dangerous env vars (e.g. `ELECTRON_RUN_AS_NODE`) and `${PROCESS_EXEC_PATH}`/`${RESOURCES_DIR}` template variables. Those features are **not available** in the other three scopes; do not put template strings in user/project/local snippets — they pass through unresolved and break `child_process.spawn`.

---

## Schema Constraints (derived from MA `schemas.ts`)

Every entry MUST satisfy `McpServerSpecSchema`:

- `transport` / `type` ∈ `{ "stdio", "http", "sse" }` — omm uses **`stdio`** only.
- `command`:
  - either an **absolute path** (Unix `/...` or Windows `C:\...`),
  - or a **whitelisted bare executable** from MA's `SAFE_BARE_COMMANDS` list: `npx | node | bun | bunx | deno | python | python3 | uvx | uv | docker | podman | java | dotnet | go | cargo | cmd`.
  - Must NOT contain `..` (path traversal).
- `args[]`: no shell metacharacters (`;|&$\`><!(){}~*?\r\n\0#'"[]`).
- `env`: keys MUST NOT be in MA's dangerous-env denylist — notably **never** set `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `ELECTRON_RUN_AS_NODE`, `HOME`, `USERPROFILE`, `LD_PRELOAD`, proxy vars, or TLS-trust vars. Values capped at 4096 chars.
- `enabled` defaults to `true` when omitted.
- `manifestId` is optional; omm does not currently ship per-server manifests — leave it out.

---

## Snippet 1 — Project Scope (`<workspace>/.matrixassistant/mcp.json`)

Use this when omm is installed per-workspace (e.g., a team repo wants every developer's MA to see omm). The file is committed to the workspace.

Replace `<OMM_ROOT>` with the absolute path where the omm tarball was unpacked (e.g., `/home/alice/.local/share/omm/0.5.0` or `C:\\Users\\alice\\AppData\\Local\\omm\\0.5.0`). On Windows, escape backslashes (`\\`) inside JSON strings.

```json
{
  "mcpServers": {
    "omm-state": {
      "type": "stdio",
      "command": "node",
      "args": ["<OMM_ROOT>/omm-packages/omm-mcp/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "<OMM_STATE_ROOT>" },
      "enabled": true,
      "tags": ["omm", "state"]
    },
    "omm-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["<OMM_ROOT>/omm-packages/omm-mcp-memory/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "<OMM_STATE_ROOT>" },
      "enabled": true,
      "tags": ["omm", "memory"]
    },
    "omm-trace": {
      "type": "stdio",
      "command": "node",
      "args": ["<OMM_ROOT>/omm-packages/omm-mcp-trace/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "<OMM_STATE_ROOT>" },
      "enabled": true,
      "tags": ["omm", "trace"]
    }
  }
}
```

`OMM_STATE_ROOT` defaults to `~/.openclaw/omm` (see `omm-config.ts`); override only when isolating state per workspace.

> **Note on `node` bare command.** MA's `SAFE_BARE_COMMANDS` allows `"command": "node"`. The actual `node` resolution happens via `child_process.spawn` against the OS `PATH` at spawn time. If your MA installation cannot resolve `node` (e.g., GUI launch on macOS without a login-shell `PATH`), substitute an absolute path: `/usr/local/bin/node`, `C:\\Program Files\\nodejs\\node.exe`, etc.

---

## Snippet 2 — User Scope (`~/.matrixassistant/mcporter/mcporter.json`)

Use this when omm should be visible across all MA workspaces for one user.

```json
{
  "mcpServers": {
    "omm-state": {
      "type": "stdio",
      "command": "node",
      "args": ["<OMM_ROOT>/omm-packages/omm-mcp/dist/src/index.js"],
      "enabled": true,
      "tags": ["omm", "state"]
    },
    "omm-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["<OMM_ROOT>/omm-packages/omm-mcp-memory/dist/src/index.js"],
      "enabled": true,
      "tags": ["omm", "memory"]
    },
    "omm-trace": {
      "type": "stdio",
      "command": "node",
      "args": ["<OMM_ROOT>/omm-packages/omm-mcp-trace/dist/src/index.js"],
      "enabled": true,
      "tags": ["omm", "trace"]
    }
  }
}
```

The user scope file may already contain other servers (e.g., `matrix-mcp-playwright`); omm entries merge under the same `mcpServers` map. Do not overwrite — see the merge rules below.

---

## Snippet 3 — Local Scope (`<workspace>/.mcp.local.json`)

Identical shape to project scope but the file is conventionally gitignored. Use this for developer-only overrides (e.g., a contributor running omm from a checkout instead of the tarball):

```json
{
  "mcpServers": {
    "omm-state": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/Matrix/oh-my-matrix/omm-packages/omm-mcp/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "D:/Matrix/oh-my-matrix/.omm-dev-state" },
      "enabled": true
    },
    "omm-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/Matrix/oh-my-matrix/omm-packages/omm-mcp-memory/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "D:/Matrix/oh-my-matrix/.omm-dev-state" },
      "enabled": true
    },
    "omm-trace": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/Matrix/oh-my-matrix/omm-packages/omm-mcp-trace/dist/src/index.js"],
      "env": { "OMM_STATE_ROOT": "D:/Matrix/oh-my-matrix/.omm-dev-state" },
      "enabled": true
    }
  }
}
```

---

## Server Name Anchoring

| Snippet key | `initialize → serverInfo.name` returned by the server | Source |
|-------------|-------------------------------------------------------|--------|
| `omm-state` | `omm-state` | `omm-packages/omm-mcp/dist/src/index.js` |
| `omm-memory` | `omm-memory` | `omm-packages/omm-mcp-memory/dist/src/index.js` |
| `omm-trace` | `omm-trace` | `omm-packages/omm-mcp-trace/dist/src/index.js` |

The snippet keys are the user-visible names MA shows in its catalog. The `serverInfo.name` is the protocol-level identity (verified by `omm-scripts/omm-smoke-mcp.mjs`). Keep them aligned to avoid catalog confusion. The legacy doc names "omm-mcp / omm-mcp-trace / omm-mcp-memory" in earlier ADRs refer to the **package directory names**, not the registered server names — use the `omm-*` names above in MA configs.

---

## Idempotent Merge Rules

When an installer (`omm-scripts/omm-ma-seed.mjs`) writes one of these snippets:

1. **Read** the target file. If it doesn't exist, create it with `{ "mcpServers": { ... } }`.
2. **Parse** as JSON. If malformed, abort with a clear error — do not silently rewrite.
3. **Merge** only the three omm entries (`omm-state`, `omm-memory`, `omm-trace`) into `mcpServers`. For each key:
   - If absent → insert.
   - If present **and** every field (`command`, `args`, `env`, `enabled`, `tags`) matches what we would write → no-op.
   - If present **and** different → **leave the user value alone** and log a warning. The user may have customized; never overwrite without explicit `--force`.
4. **Preserve** every other key in `mcpServers` (e.g., `matrix-mcp-playwright`) and every top-level field (e.g., `policy`).
5. **Write** atomically: `writeFile(path + ".tmp")` → `rename(path + ".tmp", path)`.

Rerunning the installer with the same arguments MUST produce zero diff after the first successful run.

---

## End-to-End Verification

After applying a snippet:

1. Restart MA (the registry only re-scans on startup or via `mcp:refreshCatalog` IPC).
2. Open MA's MCP catalog UI; the three `omm-*` servers should appear with `enabled: true`.
3. From the SkillSelector or MCP console, browse Resources:
   - `omm-state` should advertise `omm://state/<key>` resources for any keys present in `OMM_STATE_ROOT`.
   - `omm-trace` should advertise `omm://trace/<sessionId>` per recorded session.
   - `omm-state` Prompts surface should list entries at `omm://prompts/<name>` for every file under `omm-skills/agent-prompts/`.
4. `omm-memory` exposes tools only (no resources/prompts) per the capability matrix in [`mcp.md`](./mcp.md).

The omm-side automated equivalent is `node omm-scripts/omm-smoke-mcp.mjs --as-ma-consumer` (see `omm-scripts/omm-smoke-mcp.mjs`), which exercises the same `initialize → resources/list → resources/read` path that MA's `TransportBridge` performs at runtime and writes evidence to `.omc/state/ma-roundtrip-evidence.json`.

---

## Anti-Patterns (rejected by MA at load time)

- Using `${RESOURCES_DIR}` or `${PROCESS_EXEC_PATH}` in user/project/local scope — only the managed scope resolves these.
- Setting `ELECTRON_RUN_AS_NODE: "1"` in user/project/local scope — flagged as dangerous env and the entry is dropped silently with a warning in MA's logger.
- Relative paths in `args` — `..` is rejected by the command regex and relative paths fail at spawn time.
- Shell features in args (`$VAR`, backticks, pipes, redirects) — all blocked by `SafeArgSchema`.
- Setting `PATH` to extend the search path — blocked; rely on the OS `PATH` MA inherits.

---

## Drift Detection

This document pins:
- MA `schemas.ts` field set as observed 2026-05-12.
- MA `scope-loader.ts:69` `parsed.servers ?? parsed.mcpServers` either-key acceptance.

If MA's schema changes (e.g., a new required field, a removed scope), regenerate snippets and run the smoke harness `--as-ma-consumer` mode to confirm the wire envelope still matches. The roadmap exit citation in `docs/roadmap.md:110` is only valid against the MA commit hash recorded in the evidence file.
