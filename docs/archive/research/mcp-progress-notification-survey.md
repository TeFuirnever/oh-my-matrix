# MCP `notifications/progress` Capability Survey

> Research artifact for MCP R1 follow-up (the "UNKNOWN" row from `mcp-capability-survey.md`)
> Date: 2026-05-08
> Scope: Determine whether the MA + OpenClaw stack can consume `notifications/progress` from omm MCP servers, and recommend a path.

---

## 1. Executive Summary

**Recommendation: Defer (R3 from the original survey).**

Direct evidence from MatrixAssistant's own architecture audit explicitly marks `notifications/progress` as **NOT supported** on the MA consumer side today. Implementing it on omm MCP servers would create a dead capability with no end-to-end consumer. Re-evaluation triggers documented below.

---

## 2. Evidence

### Probe 1: MA codebase grep for the actual notification path

```
grep -r "notifications/progress|ProgressNotification|progressToken" D:/Matrix/MatrixAssistant
```

Result: **0 matches in runtime code**. Only 2 doc files mention it:
- `docs/architecture/mcp-best-practices-audit.md`
- `docs/core/mcp/2026-04-01-mcp-capability-redesign-design.md`

### Probe 2: MA's own audit verdict (load-bearing)

`@/Matrix/MatrixAssistant/docs/architecture/mcp-best-practices-audit.md:101-106`:

```
| 超时控制 | 可配置 + 合理默认值           | ✅ clampTimeout(1000-300000)         | ✅ 已修复     |
| 结果流式 | 支持流式返回                  | 不支持                               | ⚠️ 缺失       |
| 错误处理 | 结构化错误 + 路径脱敏         | ✅ 已实现路径脱敏                    | ✅ 符合       |
| 进度反馈 | notifications/progress        | 不支持                               | ⚠️ 缺失       |
...
**问题 P6**: 无流式结果返回。长时间运行的工具（如 web 抓取）无法实时反馈进度。
```

This is MA's **own self-audit** (dated 2026-03-28) explicitly identifying `notifications/progress` as a missing capability and tagging it as known issue P6.

### Probe 3: MA's worker `request-schema.ts` routing table

`@/Matrix/MatrixAssistant/electron/main/services/mcp/worker/request-schema.ts:8-21` routes only request methods (`tools/*`, `resources/*`, `prompts/*`) — **no notification routing exists in this file**. Notifications are server-to-client push and would require a separate handler path that does not appear to be implemented.

### Probe 4: SDK version

MA `package.json:105`: `"@modelcontextprotocol/sdk": "^1.27.1"`.

The SDK itself supports notifications (see `@modelcontextprotocol/sdk/types.js` exports `ProgressNotificationSchema`). The gap is **on the MA consumer side** — schema is available but not wired to any UI surface.

---

## 3. Capability Matrix Update

| Capability | Server side (omm) | Consumer side (MA) | End-to-end status |
|-----------|-------------------|--------------------|--------------------|
| `tools/*` | ✅ implemented | ✅ wired | **PASS** |
| `resources/*` | ✅ implemented (R1) | ✅ schema imported | **PASS** (consumer-ready) |
| `prompts/*` | ✅ implemented (R1) | ✅ schema imported | **PASS** (consumer-ready) |
| `notifications/progress` | ❌ not implemented | ❌ explicitly missing per MA P6 | **DEFER** |

Compare to `mcp-capability-survey.md` row 4 which marked this as UNKNOWN. With Probe 2's evidence, status is now **DEFER**, not UNKNOWN.

---

## 4. Why DEFER (and not implement-anyway)

R7 (Dead capability risk) from plan `ralplan-mcp-r1.md` already establishes the policy: advertise capabilities only when consumers exist. Implementing `notifications/progress` on omm MCP servers without an MA-side consumer would:

1. Create a dead notification path (server emits, nothing receives)
2. Add maintenance burden for a feature no user observes
3. Add a non-trivial implementation surface (server-push channel — different code path from request/response handlers)
4. Tempt premature optimization on the omm side that is constrained by what MA UI eventually adopts

By contrast, R1 (Resources + Prompts) had **schema imports already present** in MA — the consumer side was wired and waiting. `notifications/progress` has the inverse pattern: explicit absence on the consumer side.

---

## 5. Re-Evaluation Triggers

Implement `notifications/progress` on omm MCP servers **only when** at least one of these is observed:

1. **MA P6 closure**: MA team closes audit issue P6 by adding a notification handler to the MCP worker
2. **Schema routing change**: `@/Matrix/MatrixAssistant/electron/main/services/mcp/worker/request-schema.ts` adds a method case for notifications, OR a sibling notification handler appears
3. **MA UI request**: MA team explicitly requests progress notifications from omm for a specific user-facing surface (e.g., long-running ralph iterations needing progress bars in MA UI)
4. **MCP spec update**: MCP spec elevates progress notifications to a required capability for tools/* (currently optional)

When triggered, the implementation pattern is straightforward — server-push via stdout `{"jsonrpc":"2.0","method":"notifications/progress","params":{...}}` lines, sized to fit the existing `MAX_REQUEST_BYTES` cap. No SDK changes needed.

---

## 6. Implementation Sketch (for trigger-fired follow-up plan, NOT this cycle)

If/when triggers fire, the smallest viable implementation:

```typescript
// In omm-mcp/src/index.ts (or omm-mcp-trace), add a progress emitter:

interface ProgressNotification {
  jsonrpc: "2.0";
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

function emitProgress(params: ProgressNotification["params"]): void {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params,
    })}\n`,
  );
}

// Long-running tool handlers receive progressToken from request meta
// and call emitProgress() between work units.
```

This is a ~30 LOC sketch per server when needed. Not appropriate now.

---

## 7. References

- Original survey: `docs/research/mcp-capability-survey.md` (R1 implementation done; R3 UNKNOWN row is what this report resolves)
- MA self-audit: `@/Matrix/MatrixAssistant/docs/architecture/mcp-best-practices-audit.md:101-106` (issue P6)
- MA worker routing: `@/Matrix/MatrixAssistant/electron/main/services/mcp/worker/request-schema.ts:8-21`
- MCP spec progress notifications: https://modelcontextprotocol.io/specification (server notifications section)
- ADR-003: zero-dep MCP servers (any future implementation must respect this)

---

## 8. Status

**Conclusion**: `notifications/progress` is **not implementation-ready**. Defer until MA side wires a consumer. Original survey row 4 (UNKNOWN) is now resolved as DEFER with explicit triggers for re-evaluation.

This closes the third leg of the MCP capability triplet (Resources/Prompts implemented; Progress deferred with documented evidence).
