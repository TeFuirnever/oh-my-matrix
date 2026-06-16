# OMM Plugin Enhancement v0.5 — Design Document (Rev.4)

> **Status:** Draft (Rev.4 — tool surface reduction + minimal additions)
> **Date:** 2026-06-16
> **Version:** 0.4.2 → 0.5.0
> **API Version:** 0.3 (unchanged)

---

## 1. Background & Motivation

oh-my-matrix (OMM, v0.4.2) is an OpenClaw-native plugin providing orchestration tools for MatrixAssistant (MA). Post ADR-008 converged to single-mode `team`.

当前 8 个注册工具中，有 3 个工具 team skill 从未调用（验证结果见 Section 2）。v0.5 的核心目标从"增加新能力"转为 **"裁剪冗余，聚焦价值特性"**：

1. **移除 3 个未使用的工具** — 减少 37.5% 的工具表面积
2. **添加 2 个 compaction hook 事件** — 低成本的宿主扩展点
3. **声明 hooks 数组到 plugin manifest** — 与 autopilot 插件最佳实践对齐

---

## 2. Tool Usage Audit（验证依据）

对 `omm-skills/omm-team/SKILL.md`（唯一的 shipped skill）做了引用分析：

| 工具 | Team Skill 引用 | 结论 |
|------|----------------|------|
| `omm_state_write` | 直接使用（状态机核心） | **保留** |
| `omm_state_read` | 直接使用（读取/恢复状态） | **保留** |
| `omm_state_list` | **零引用** | **移除** — team 只用 `"team"` 一个 key，list 是调试工具 |
| `omm_agent_prompt_get` | **零引用** | **移除** — MCP server 的 Prompts catalog 已覆盖此能力 |
| `omm_agent_prompt_list` | **零引用** | **移除** — 配套工具，同上 |
| `omm_employee_list` | 直接使用（MA 路径检测） | **保留** |
| `omm_employee_dispatch` | 直接使用（子任务派发） | **保留** |
| `omm_employee_result` | 直接使用（结果轮询） | **保留** |

注：`omm_agent_prompt_get` 仅在 `planner.md` agent prompt 文件中被提及（自引用），team skill 本身从不调用。

---

## 3. Changes

### 3.1 移除 3 个工具

从 `omm-register.ts` 中移除以下工具注册：

| 移除项 | 涉及代码 |
|--------|---------|
| `omm_state_list` 注册块 | `omm-register.ts` 中的 `api.registerTool(...)` 块 |
| `omm_agent_prompt_get` 注册块 | 同上 |
| `omm_agent_prompt_list` 注册块 | 同上 |
| `runOmmStateList` import | `omm-register.ts` 顶部 import |
| `runOmmAgentPromptGet/List` import | 同上 |
| `verifyAgentPromptsAvailable` import + 调用 | `omm-register.ts` 中 sentinel check（agent prompt 工具移除后不再需要） |

**不删除源文件** — `omm-tools/omm-agent-prompt.ts`、`omm-tools/omm-state.ts` 中的 `runOmmStateList` 等函数保留。原因：
- `omm-agent-prompt.ts` 仍被 MCP server（`omm-mcp/src/index.ts`）消费
- `runOmmStateList` 仍被测试和 MCP server 消费
- 只从 plugin 注册层移除，不从代码库删除

### 3.2 添加 2 个 Compaction Hook 事件

添加 `before_compaction` 和 `after_compaction` 到 `OmmHookEvent` 联合类型。

**纯 dispatch** — 使用 `makeDispatchOnlyHandler`，不含自定义 handler 逻辑。只是把事件转发给用户自定义的 hook 模块（`{stateRoot}/hooks/before_compaction/*.mjs`）。

```typescript
export const handleBeforeCompaction = makeDispatchOnlyHandler("before_compaction");
export const handleAfterCompaction = makeDispatchOnlyHandler("after_compaction");
```

在 `omm-register.ts` 中注册：
```typescript
api.on("before_compaction", (ev, ctx) =>
  handleBeforeCompaction(merge(ev, ctx), { stateRoot }),
);
api.on("after_compaction", (ev, ctx) =>
  handleAfterCompaction(merge(ev, ctx), { stateRoot }),
);
```

### 3.3 Plugin Manifest Update

`openclaw.plugin.json` 变更：

1. **版本** — `0.4.2` → `0.5.0`
2. **添加 `hooks` 数组** — 声明全部 14 个 hook 事件（与 autopilot 插件 manifest 模式一致）

```json
{
  "id": "omm",
  "name": "omm",
  "version": "0.5.0",
  "apiVersion": "0.3",
  "hooks": [
    "session_start", "session_end",
    "before_tool_call", "after_tool_call",
    "llm_input", "llm_output",
    "agent_end",
    "subagent_spawning", "subagent_spawned", "subagent_ended",
    "gateway_start", "gateway_stop",
    "before_compaction", "after_compaction"
  ]
}
```

---

## 4. What Is NOT Changed

| 保持不变 | 理由 |
|---------|------|
| Error codes (`omm-error-codes.ts`) | 无新错误场景 |
| State validation (`omm-state-validation.ts`) | team schema 不变 |
| Hook handlers（existing 12） | 行为不变 |
| MCP server (`omm-mcp/src/index.ts`) | 保留 state + agent-prompt 的 MCP 暴露 |
| Agent prompts（19 个 .md 文件） | 仍通过 MCP Prompts catalog 消费 |
| `omm-tools/omm-state.ts` 源文件 | `runOmmStateList` 保留供 MCP server 使用 |

---

## 5. Files Changed

### Modified Files (3)

```
omm-packages/omm-plugin/src/omm-register.ts     # -3 tool registrations, -2 imports, -sentinel check, +2 hook registrations, +2 imports
omm-packages/omm-plugin/src/omm-hooks.ts         # +2 compaction event types, +2 dispatch handlers
omm-packages/omm-plugin/openclaw.plugin.json      # version 0.5.0 + hooks array
```

### No New Files, No Deleted Files

---

## 6. Migration Impact

### For Plugin Consumers (MA, OpenClaw hosts)

- `omm_state_list` 不再通过 plugin 注册 — 如果宿主直接调用此工具，需改为通过 MCP server 访问（`omm_state_list` 仍在 MCP 中可用）
- `omm_agent_prompt_get/list` 同上 — 通过 MCP Prompts catalog 访问
- 已有的 `omm_state_read/write` 和 `omm_employee_*` 调用不受影响

### For Team Skill

- 零影响 — team skill 从不使用被移除的 3 个工具

---

## 7. Verification

1. **Build:** `pnpm build` — no `error TS` output
2. **Tests:** `pnpm test` — all 255 existing tests pass
3. **Lint:** `pnpm lint` — Biome passes
4. **Plugin 注册验证:** 构建后 `omm-register.ts` 只注册 5 个工具 + 14 个 hook
5. **MCP 不受影响:** `omm-mcp` 仍暴露 `omm_state_list` + agent prompt tools
6. **Team skill 不受影响:** `omm-team/SKILL.md` 引用的 5 个工具全部保留

---

## Appendix: Evolution Path

| 版本 | 候选能力 | 前提 |
|------|---------|------|
| v0.5.1 | State TTL（`omm_state_write` 加 `ttl` 参数 + `omm_state_cleanup`） | 确认 team 或 MA 有 TTL 需求 |
| v0.6.0 | Trace Analysis（`omm_trace_timeline`, `omm_trace_summary`） | 确认有消费需求 |
| v0.6.0 | Learner system | OpenClaw 支持 `agent_turn_prepare` |
| Future | Notepad / Shared Memory | 发现 state-based 方案不够用 |

---

## Appendix: Rev.1 → Rev.4 Changelog

- **Rev.1:** 14 new tools across 4 capability layers
- **Rev.2:** Post adversarial review — fixed compaction hook pairing, security, MCP sync
- **Rev.3:** Radical simplification — 1 new tool + TTL extension + 2 hook events
- **Rev.4:** Tool surface reduction — remove 3 unused tools, add 2 compaction hooks, declare hooks manifest. Net: 8 → 5 tools, 12 → 14 hooks. Zero new files.
