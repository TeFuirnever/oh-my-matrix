# omm MCP Server Contracts

> Internal contract between omm MCP servers and consumers (OpenClaw runtime, MatrixAssistant UI).

This document records the URI scheme, capability advertisements, and naming conventions for omm's 3 MCP servers post-R1 (2026-05-08).

---

## URI Scheme

omm uses the private `omm://` URI scheme for MCP Resources. The scheme is **not registered with IANA** — it is a host-private convention recognized by the OpenClaw runtime and MA's MCP routing layer (`@modelcontextprotocol/sdk`).

| URI pattern | Server | Maps to | MIME type |
|-------------|--------|---------|-----------|
| `omm://state/<key>` | omm-mcp | `{stateRoot}/state/<key>.json` | `application/json` |
| `omm://prompts/<name>` | omm-mcp | `omm-skills/agent-prompts/<name>.md` | (text in Prompt body) |
| `omm://trace/<sessionId>` | omm-mcp-trace | `{stateRoot}/trace/<sessionId>.jsonl` | `application/x-jsonlines` |

### URI validation

- Both `<key>` and `<sessionId>` must match `/^[a-z0-9][a-z0-9_-]{0,63}$/i` (the same pattern enforced by `assertSafeKey`)
- `<name>` must match `/^[a-z][a-z0-9-]*$/` (the same pattern as omm-plugin's `parseAgentPrompt` loader)
- Path traversal sequences (`..`, `/`, `\`) are rejected at the regex layer; `assertSafeKey` adds a second-layer check

---

## Capability Matrix (post-R1)

| Server | tools | resources | prompts |
|--------|-------|-----------|---------|
| `omm-mcp` (state) | ✅ | ✅ | ✅ |
| `omm-mcp-trace` (trace) | ✅ | ✅ | — |
| `omm-mcp-memory` (memory) | ✅ | — | — |

`initialize` capabilities object on each server reflects exactly what is implemented (capability honesty principle from the R1 plan).

---

## Prompts Surface — Temporary Placement

The Prompts surface (`prompts/list` + `prompts/get`) lives on **omm-mcp** rather than on a dedicated `omm-mcp-prompts` server because:

1. `omm-mcp` is the most-used server (state operations are the primary path)
2. The `omm-skills/agent-prompts/` directory is filesystem-adjacent to `omm-mcp` via the package-root path resolution pattern (`omm-agent-prompts.ts:26-31`)
3. Adding a 4th server would inflate the MCP server count (currently 3) and the deployment matrix without immediate benefit

If the catalog of standardized prompts grows beyond agent-prompts (e.g., user-supplied prompt templates), consider extracting to a dedicated `omm-mcp-prompts` server (ADR-007 follow-up).

---

## Resources are Read-Only

omm MCP Resources are exposed read-only. Mutation channels remain on tools (`omm_state_write`, `omm_trace_record`, etc.) for these reasons:

- MCP `resources/*` methods are spec-defined as read-only (no `resources/write`)
- omm has well-established validation and locking on tool-based writes (see ADR-004, ADR-005); duplicating that surface on Resources would risk drift
- Read-only Resources are sufficient for the primary use case: UI consumers viewing state/trace timelines and agent persona libraries

---

## Discovery Pattern

A consumer initializing the omm MCP servers should:

1. Call `initialize` to confirm protocol version `2024-11-05` and capability set
2. Call `tools/list`, `resources/list`, `prompts/list` (where supported per matrix above) to discover available items
3. For Resources, parse the `mimeType` field to pick a renderer
4. For Prompts, the `messages` array uses MCP `system`/`user`/`assistant` roles per spec

---

## References

- MCP spec 2025-06-18: https://modelcontextprotocol.io/specification
- omm capability survey: `docs/research/mcp-capability-survey.md`
- ADR-001 (pure plugin, no CLI): `docs/adr/001-pure-plugin-no-cli.md`
- ADR-003 (zero-dep MCP servers): `docs/adr/`
- ADR-005 (cross-process locking): `docs/adr/005-cross-process-locking.md`
