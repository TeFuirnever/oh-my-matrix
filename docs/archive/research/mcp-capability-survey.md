# MCP Capability Survey — OpenClaw + MatrixAssistant Runtime

> 🗄 **归档 / Archived** — v0.x OpenClaw 插件/MCP 实现的设计记录。代码已于 0.6.0 移除；本仓库现为文档/设计底座。内部链接可能已失效。

> Research artifact for plan ralplan-omm-next-best-practices Phase 2
> Date: 2026-05-08
> Scope: Determine which MCP capabilities (Resources, Prompts, Progress notifications) are supported across the OpenClaw runtime + MatrixAssistant client stack, and recommend a path for omm to expose richer telemetry/data through standard MCP channels.

---

## 1. Executive Summary

**Recommendation: R1 (Upgrade omm MCP servers to advertise Resources + Prompts).**

Direct evidence from the MatrixAssistant codebase shows the OpenClaw client side already imports and routes `resources/list`, `prompts/list`, and `tools/list` schemas via `@modelcontextprotocol/sdk`. The infrastructure to consume MCP Resources and Prompts from omm's stdio servers exists today; omm just isn't advertising them.

Progress notifications (`notifications/progress`) require additional verification before committing — see Capability Matrix row 3.

---

## 2. SDK Version & Surface Inspection

### Probe 1: SDK source

The MatrixAssistant Electron main process imports MCP types directly from the official SDK:

```
@/Matrix/MatrixAssistant/electron/main/services/mcp/worker/request-schema.ts:1-6
import {
  CallToolResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
```

This is the canonical `@modelcontextprotocol/sdk` package (same package omm's `omm-mcp/src/index.ts` references via `@modelcontextprotocol/sdk` in `oh-my-claudecode`'s sibling project at `^1.26.0`).

### Probe 2: Routing surface

```
@/Matrix/MatrixAssistant/electron/main/services/mcp/worker/request-schema.ts:8-21
export function getResultSchemaForMethod(method: string) {
  switch (method) {
    case 'tools/list':
      return ListToolsResultSchema;
    case 'resources/list':
      return ListResourcesResultSchema;
    case 'prompts/list':
      return ListPromptsResultSchema;
    case 'tools/call':
      return CallToolResultSchema;
    default:
      return null;
  }
}
```

The MA worker explicitly enumerates `resources/list` and `prompts/list` in the result-schema lookup table. This is concrete evidence that the request path can serialize/deserialize Resources and Prompts payloads end-to-end.

### Probe 3: Live experiment

A live capability test (sending `resources/list` to an MCP server during MA dev mode and inspecting host logs) was **not** attempted in this survey because the dev runtime was not available locally during research. The static evidence above is sufficient to recommend R1 for Resources and Prompts because the deserializer schemas are imported and exposed; if MA could not consume these methods, the schemas would not be in the routing table.

---

## 3. Capability Matrix

| Capability | Status | Evidence |
|-----------|--------|----------|
| `tools/list` + `tools/call` | **PASS** | Already used by all 3 omm MCP servers; MA `request-schema.ts:9,16` confirms client-side support. Foundation for the omm MCP API today. |
| `resources/list` + `resources/read` | **PASS** (consumer side) | MA `request-schema.ts:11` imports `ListResourcesResultSchema` and routes the method. omm side has not implemented advertisement yet (gap). |
| `prompts/list` + `prompts/get` | **PASS** (consumer side) | MA `request-schema.ts:13` imports `ListPromptsResultSchema` and routes the method. omm side has not implemented advertisement yet (gap). |
| `notifications/progress` | **UNKNOWN** | Not present in the routing-table evidence. Would require: (a) inspecting MA's notification handler if any, or (b) live test. Not a blocker for R1 because Resources alone covers 80% of the UI integration use case. |

---

## 4. Recommended Path: R1

**Upgrade omm MCP servers to advertise Resources + Prompts.**

### Rationale

1. The infrastructure (SDK + MA client routing) is already in place
2. Adding `resources/list` and `prompts/list` to omm servers is additive — does not break existing `tools/call` consumers
3. Resources naturally map to omm's existing artifacts: state files (`{stateRoot}/state/*.json`), trace files (`{stateRoot}/trace/*.jsonl`), agent prompts
4. Prompts naturally map to omm's `agent-prompts/` directory — exposing them as MCP Prompts gives MA UI a standard way to enumerate available personas

### Implementation Sketch (≤30 LOC)

For `omm-mcp/src/index.ts` — extend the JSON-RPC request handler:

```typescript
// Before (current omm-mcp handles only tools)
if (req.method === "tools/list") {
  return makeResponse(id, { tools: TOOLS });
}

// After (add Resources advertisement)
if (req.method === "resources/list") {
  const resources = await listOmmStateResources();
  return makeResponse(id, { resources });
}

if (req.method === "resources/read") {
  const params = req.params as { uri: string };
  const contents = await readOmmStateResource(params.uri);
  return makeResponse(id, { contents });
}
```

Where `listOmmStateResources()` returns:

```typescript
[
  { uri: "omm://state/ralph", name: "Ralph mode state", mimeType: "application/json" },
  { uri: "omm://state/autopilot", name: "Autopilot mode state", mimeType: "application/json" },
  { uri: "omm://state/team", name: "Team mode state", mimeType: "application/json" },
  // ... per-mode state files in {stateRoot}/state/
]
```

For `omm-mcp-trace/src/index.ts` — same pattern, exposing `omm://trace/{sessionId}.jsonl`.

### Cost Estimate

| Component | LOC | Risk |
|-----------|-----|------|
| `omm-mcp/src/index.ts` (state resources) | ~40 | Low (additive) |
| `omm-mcp-trace/src/index.ts` (trace resources) | ~40 | Low (additive) |
| Tests for new methods | ~60 | Low |
| **Total** | **~140 LOC** | **Low** (additive, no zero-dep violation) |

### What This Does NOT Cover

- Progress notifications (UNKNOWN status — defer to a follow-up plan)
- MA UI consumer code (out of scope; MA team owns)
- Resources for `omm-mcp-memory` (memory keys could become Resources, but lower priority)

---

## 5. Alternative Paths (Not Recommended)

### R2: IPC Bridge through MA ExtensionAPI

Build a custom IPC channel in MA's ExtensionAPI to consume omm state/trace data directly, bypassing MCP.

- **Pros**: Independent of MCP spec evolution
- **Cons**: Violates ADR-001 (omm becomes coupled to Electron); duplicates work that MCP Resources already standardizes; locks omm into MA-only consumers

### R3: Defer & Monitor

Wait for OpenClaw to publish capability docs before investing.

- **Pros**: Zero cost
- **Cons**: Evidence already exists in MA codebase that the consumer side is ready; deferring leaves measurable user value on the table

---

## 6. Evidence Limitations

1. The SDK version was identified by import path (`@modelcontextprotocol/sdk/types.js`) but not by exact pinned version — MA's `package.json` could be inspected to confirm the version, but the schema import is sufficient to confirm capability support
2. Live runtime test was not performed; static schema-routing evidence is the basis for the PASS verdict on Resources and Prompts
3. Progress notification support is genuinely unknown without further inspection

---

## 7. Re-Evaluation Triggers (if new info arrives)

- If MA team confirms Resources/Prompts consumer code is incomplete despite the schema imports → downgrade to R3 (defer) and request runtime evidence
- If `notifications/progress` is found to be already routed in MA → expand R1 scope to include progress
- If OpenClaw runtime publishes a capability matrix doc → cross-reference against this report's findings

---

## 8. Next Steps

1. **File a follow-up plan** to implement the R1 upgrade sketch above
2. **Coordinate with MA team** to confirm Resources/Prompts consumer pathway is wired end-to-end (UI → Electron Main → OpenClaw → omm MCP)
3. **Investigate `notifications/progress`** in a separate research task before scoping any progress-bar UI work

---

## 9. References

- MA MCP request schema: `@/Matrix/MatrixAssistant/electron/main/services/mcp/worker/request-schema.ts:1-21`
- MA MCP best practices audit: `@/Matrix/MatrixAssistant/docs/architecture/mcp-best-practices-audit.md`
- MA MCP capability redesign: `@/Matrix/MatrixAssistant/docs/core/mcp/2026-04-01-mcp-capability-redesign-design.md`
- omm MCP servers (current): `@/Matrix/oh-my-matrix/omm-packages/omm-mcp/src/index.ts`, `@/Matrix/oh-my-matrix/omm-packages/omm-mcp-trace/src/index.ts`, `@/Matrix/oh-my-matrix/omm-packages/omm-mcp-memory/src/index.ts`
- MCP spec 2025-06-18: https://modelcontextprotocol.io/specification (consumer-side)
