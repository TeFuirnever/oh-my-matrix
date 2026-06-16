<!-- Updated: 2026-06-16 -->

# MA Integration Snippets — omm MCP Server

> Drop-in JSON snippets for registering omm's MCP server into MatrixAssistant (MA) via OpenClaw's native MCP config format. MA reads `~/.openclaw/openclaw.json` and discovers servers under `mcp.servers`.
>
> **v0.5 (2026-06-16):** only `omm-state` (the `omm-mcp` package) ships. The `omm-memory` / `omm-trace` servers were removed as non-essential; any snippets referencing them are obsolete.
>
> Cross-references:
> - [`mcp.md`](./mcp.md) — omm MCP URI scheme and capability matrix
> - [`mcp-protocol-contract.md`](./mcp-protocol-contract.md) — JSON-RPC wire format
> - [`../architecture.md`](../architecture.md) §"Consumer Integration" — how MA unpacks the tarball

---

## Audience

You are a MatrixAssistant user (or omm-bundle script) who wants MA's built-in MCP client to discover and consume omm's MCP server — `omm-state` — so that MA's UI can list omm Resources (`omm://state/<key>`) and the agent-prompts catalog (`omm://prompts/<name>`) end-to-end. The automated installer is `node omm-scripts/omm-ma-seed.mjs`; it defaults to dry-run and writes only when `--write` is passed.

---

## Config Format

MA uses OpenClaw's native config at `~/.openclaw/openclaw.json`. Servers are nested under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "<server-name>": {
        "command": "node",
        "args": ["<entrypoint>"],
        "env": { ... }
      }
    }
  }
}
```

Each server entry uses `{ command, args, env }` — stdio transport is auto-detected from `command` presence. No `type`, `enabled`, or `tags` fields are needed.

---

## Config Scopes

| Scope | Path | Set via |
|-------|------|--------|
| `user` | `~/.openclaw/openclaw.json` | `--scope user` (default) |
| `project` | `<workspace>/.matrixassistant/mcp.json` | `--scope project --workspace <path>` |
| `local` | `<workspace>/.mcp.local.json` | `--scope local --workspace <path>` |

omm targets any of these scopes. The `user` scope is recommended for per-user visibility across all workspaces.

---

## Snippet — User Scope (recommended)

This is what `omm-ma-seed.mjs` writes to `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "omm-state": {
        "command": "node",
        "args": ["<OMM_ROOT>/omm-mcp/dist/src/index.js"]
      }
    }
  }
}
```

Replace `<OMM_ROOT>` with the absolute path where the omm tarball was unpacked or the source checkout root. On Windows, use forward slashes in JSON strings (e.g., `D:/Matrix/Productivity/oh-my-matrix/...`).

The user scope file may already contain other servers (e.g., `matrix-mcp-playwright`, `context7`); the omm entry merges under the same `mcp.servers` map. Do not overwrite — see the merge rules below.

---

## Snippet — With Custom State Root

To isolate omm state to a specific directory, add `env.OMM_STATE_ROOT`:

```json
{
  "mcp": {
    "servers": {
      "omm-state": {
        "command": "node",
        "args": ["D:/Matrix/Productivity/oh-my-matrix/omm-packages/omm-mcp/dist/src/index.js"],
        "env": { "OMM_STATE_ROOT": "D:/Matrix/oh-my-matrix/.omm-dev-state" }
      }
    }
  }
}
```

`OMM_STATE_ROOT` defaults to `~/.openclaw/omm` (see `omm-config.ts`); override only when isolating state per workspace.

---

## Server Name Anchoring

| Snippet key | `initialize → serverInfo.name` returned by the server | Source |
|-------------|-------------------------------------------------------|--------|
| `omm-state` | `omm-state` | `omm-packages/omm-mcp/dist/src/index.js` |

The snippet key is the user-visible name MA shows in its catalog. The `serverInfo.name` is the protocol-level identity (verified by `omm-scripts/omm-smoke-mcp.mjs`). Keep them aligned to avoid catalog confusion.

> Obsolete keys (`omm-memory`, `omm-trace`) and their `omm-mcp-memory` / `omm-mcp-trace` packages were removed in v0.5. If your `openclaw.json` still lists them from an older omm install, remove those entries — their entrypoints no longer exist and will fail to spawn.

---

## Idempotent Merge Rules

When an installer (`omm-scripts/omm-ma-seed.mjs`) writes this entry:

1. **Read** the target file. If it doesn't exist, create it with the full `mcp.servers` structure.
2. **Parse** as JSON. If malformed, abort with a clear error — do not silently rewrite.
3. **Detect** the servers key: prefers `mcp.servers` (OpenClaw native), falls back to `servers` then `mcpServers`.
4. **Merge** only the `omm-state` entry. For the key:
   - If absent → insert.
   - If present **and** every field matches → no-op.
   - If present **and** different → **leave the user value alone** and log a warning. The user may have customized; never overwrite without explicit `--force`.
5. **Preserve** every other key in the servers map and every top-level field.
6. **Write** atomically: `writeFile(path + ".tmp")` → `rename(path + ".tmp", path)`.

Rerunning the installer with the same arguments MUST produce zero diff after the first successful run.

---

## End-to-End Verification

After running the seeder:

```bash
# 1. Dry-run to preview
node omm-scripts/omm-ma-seed.mjs --json

# 2. Write to openclaw.json
node omm-scripts/omm-ma-seed.mjs --write

# 3. Verify the entry exists
node -e "const d=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.openclaw/openclaw.json','utf8')); console.log(Object.keys(d.mcp.servers).filter(k=>k.startsWith('omm-')).join(', '))"
```

Then in MA:

1. Restart MA (the registry re-scans on startup).
2. Open MA's MCP catalog UI; the `omm-state` server should appear.
3. Browse Resources:
   - `omm-state` should advertise `omm://state/<key>` resources.
   - `omm-state` Prompts should list entries at `omm://prompts/<name>`.

The omm-side automated equivalent is `node omm-scripts/omm-smoke-mcp.mjs --as-ma-consumer`.

---

## Anti-Patterns

- Relative paths in `args` — fail at spawn time.
- Shell features in args (`$VAR`, backticks, pipes, redirects) — blocked by the seeder's safety checks.
- Adding `type: "stdio"` — unnecessary; stdio is auto-detected from `command`.
- Adding `enabled: true` or `tags` — not part of the OpenClaw config schema.
- Re-registering `omm-memory` / `omm-trace` — removed in v0.5; their entrypoints no longer exist.

---

## Drift Detection

This document pins:
- OpenClaw native format: `mcp.servers` in `~/.openclaw/openclaw.json`.
- Server entry shape: `{ command, args, env? }` — no type/enabled/tags.
- Shipped server set: `omm-state` only (v0.5).

If MA's config format changes, regenerate snippets and run the smoke harness `--as-ma-consumer` mode to confirm the wire envelope still matches.
