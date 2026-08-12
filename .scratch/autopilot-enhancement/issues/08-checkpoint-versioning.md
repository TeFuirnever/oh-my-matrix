# 08 — Checkpoint schemaVersion + 原子幂等

**What to build:** checkpoint 带 schema 版本 + 恢复时 migration 钩子 + 原子替换防重跑重复写入。3.0.0 trustWorkspace flip 已示范"静默破坏旧 checkpoint"的失败类。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent（仅记录，未开发）

## /code-review 关联（F3，2026-08-11）
02 引入的 `FoldedAggregate.lastValidatedTurn`（feacd81）在旧 checkpoint 不存在 → `lastProgressTurn` fallback `?? 0`（`progress-ledger.ts:171`）→ 升级后 resume：全 failed detail + 旧折叠 → `lastProgressTurn=0` → gap=10 ≥ 3 → **零新轮就 pause(no_progress)**。本 ticket 的 migration 钩子须覆盖此 case。

另：`loadCheckpoint`（`state-persister.ts:336`）恢复 ledger 但**不恢复 `state.evidence`**（只 checkpoint 了 evidenceStatus 字符串、不读回）→ crash 恢复后新 entry 恒 `undefined` → evidence-coupled 信号重置。同批修。

- [ ] checkpoint 写入带 schemaVersion
- [ ] 恢复时版本检查 + migration 钩子（不匹配 → 明确错误而非静默）
- [ ] **migration normalize：旧 folded 补 `lastValidatedTurn`（F3）+ 恢复 `state.evidence`**
- [ ] 原子替换（写入临时 + rename，防半写）
- [ ] 重跑幂等（同内容不重复写/冲突可检测）
- [ ] 契约测试：旧版本 checkpoint 恢复路径（含 F3 legacy-ledger 不误暂停）

