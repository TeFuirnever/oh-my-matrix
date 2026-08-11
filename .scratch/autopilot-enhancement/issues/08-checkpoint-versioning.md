# 08 — Checkpoint schemaVersion + 原子幂等

**What to build:** checkpoint 带 schema 版本 + 恢复时 migration 钩子 + 原子替换防重跑重复写入。3.0.0 trustWorkspace flip 已示范"静默破坏旧 checkpoint"的失败类。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] checkpoint 写入带 schemaVersion
- [ ] 恢复时版本检查 + migration 钩子（不匹配 → 明确错误而非静默）
- [ ] 原子替换（写入临时 + rename，防半写）
- [ ] 重跑幂等（同内容不重复写/冲突可检测）
- [ ] 契约测试：旧版本 checkpoint 恢复路径
