# 06 — goal 验收标准字段（吸收遗留 T05 轻量版）

**What to build:** goal 从 free-text 升级为可携带"怎么算达成"的验收摘要（acceptance 摘要字段，非完整 AC schema）——给证据门一个可对照的目标陈述。向后兼容纯文本 goal。

**Blocked by:** None — can start immediately

**Status:** ✅ 已实施（master commit bdf4815 `feat(autopilot): goal predicates with AC-NNN block`）— 零 schema 变更的更优实现

## 已交付（bdf4815，主 session）
- `src/acceptance-criteria.ts`：纯 parse/render/inject（AC-NNN block 嵌入 goal string，零 schema 变更，向后兼容）
- `goalInjectionText` 在 `agent_turn_prepare` + `buildRetryInstruction` 两处渲染（intent + compact AC list）
- `MAX_GOAL_LENGTH` 500→2000（AC block 空间）
- 8 单测（parse/render/inject/backward-compat），983 passed

- [x] goal 可携带验收摘要（向后兼容 free-text）
- [x] 验收摘要透出投影（可展示）
- [x] 完成判定/证据门可对照验收摘要（至少可追踪）
- [x] 文档更新：goal 格式说明
