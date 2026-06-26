# ADR-003: Zero-Dependency Hand-Written MCP

> 🗄 **归档 / Archived** — v0.x OpenClaw 插件/MCP 实现的设计记录。代码已于 0.6.0 移除；本仓库现为文档/设计底座。内部链接可能已失效。

## Context

oh-my-codex uses `@modelcontextprotocol/sdk` for its 5 MCP servers. The SDK provides connection management, protocol validation, type safety, and transport abstractions. However, it adds a runtime dependency with its own dependency tree.

omm has a single MCP server (state access only) with 3 tools. The MCP 2024-11-05 protocol over stdio is straightforward: one JSON-RPC message per line, a simple handshake, and a small method set (`initialize`, `tools/list`, `tools/call`).

## Decision

omm implements MCP manually using only Node.js built-in modules（零依赖手写实现）:

- `node:readline` for line-by-line stdin parsing (CRLF-tolerant)
- `JSON.parse` / `JSON.stringify` for JSON-RPC message handling
- `node:fs/promises` for state file I/O
- Inline validation logic mirroring `omm-state-validation.ts`

No external packages are imported at runtime.

## Consequences

**Positive:**

- Zero runtime dependencies — nothing to audit, update, or break
- Minimal bundle size: the entire MCP server is ~260 lines
- Full control over protocol handling — no SDK abstractions to work around
- Matches omm's overall zero-dependency design philosophy

**Negative:**

- Manual protocol tracking: if MCP spec evolves past 2024-11-05, omm must update manually
- Duplicated validation: MCP server inlines a simplified copy of plugin validation logic, creating a maintenance surface for keeping them in sync
- No type-safe protocol layer: JSON-RPC parsing uses `as` casts, not validated schemas
- Missing protocol features: no support for resources, prompts, or sampling — only tools

**Trade-off accepted:** For a single-server, 3-tool use case, the SDK's overhead exceeds its value. The duplication risk is managed by keeping the MCP server's validation minimal (phase + terminal checks only) while the plugin's validation is authoritative.
