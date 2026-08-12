# 08 — Checkpoint schemaVersion + 原子幂等

**What to build:** checkpoint 带 schema 版本 + 恢复时 migration 钩子 + 原子替换防重跑重复写入。3.0.0 trustWorkspace flip 已示范"静默破坏旧 checkpoint"的失败类。

**Blocked by:** None — can start immediately

**Status:** ✅ 已实施（本 worktree，2026-08-12）— schemaVersion + migration + F3 normalize + evidence 恢复。原子替换/写锁既有，无需重做。

## /code-review 关联（F3，2026-08-11）— ✅ 已修
02 引入的 `FoldedAggregate.lastValidatedTurn`（feacd81）在旧 checkpoint 不存在 → `lastProgressTurn` fallback `?? 0`（`progress-ledger.ts:171`）→ 升级后 resume：全 failed detail + 旧折叠 → `lastProgressTurn=0` → gap=10 ≥ 3 → **零新轮就 pause(no_progress)**。本 ticket 的 migration 钩子须覆盖此 case。

另：`loadCheckpoint`（`state-persister.ts:336`）恢复 ledger 但**不恢复 `state.evidence`**（只 checkpoint 了 evidenceStatus 字符串、不读回）→ crash 恢复后新 entry 恒 `undefined` → evidence-coupled 信号重置。同批修。

## 实施（2026-08-12）
- [x] checkpoint 写入带 schemaVersion（`CHECKPOINT_SCHEMA_VERSION = 2`）
- [x] 恢复时版本检查 + migration 钩子（`migrateCheckpoint`）
- [x] **migration normalize：旧 folded 补 `lastValidatedTurn`（F3）+ 恢复 `state.evidence`**
- [x] 原子替换（写入临时 + rename，防半写）— **既有（`:215-222` atomicWriteFileSync），无需重做**
- [x] 重跑幂等（同内容不重复写/冲突可检测）— **既有（`:208` writeLocks per-runId），无需重做**
- [x] 契约测试：旧版本 checkpoint 恢复路径（含 F3 legacy-ledger 不误暂停）— 6 测试

### 既有实现复用（勘探发现，未重复造轮子）
原子写（tmp + renameSync）和 per-runId 写锁在 Review #4 已落地。本 ticket 只补 schema 版本化 + migration,不碰既有 I/O 路径。

### migration 语义决策（surface per AGENTS.md）
- **旧 folded 无法重推导 `lastValidatedTurn`** —— folded aggregate 已把 per-turn evidence 聚合丢失,历史 validated turn 不可恢复 → 保守置 0。不恶化 F3(detail entries 自带 evidenceStatus,`lastProgressTurn` 读 detail 优先,全 failed 时才 fallback folded,此时 0 与旧 `?? 0` 行为一致)。
- **未来高版本 schemaVersion(> 2)拒绝** —— fail-silent 返回 null + forensic `console.error`,不静默误读(ticket 要求"明确错误而非静默")。

