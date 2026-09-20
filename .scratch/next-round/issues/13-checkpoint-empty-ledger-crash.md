# 13 — checkpoint `ledger:{}` restore 后 gateway 崩溃循环

**What to build:** 已修复（本票即修复记录）。`loadCheckpoint` 对 `cp.ledger` 做归一化（`normalizeLedger`），空/部分形状补全 `entries`/`folded` 缺省；`progress-ledger` 全部公开函数的 `?? emptyLedger()` 升级为 `coerceLedger`（防 `undefined` 与 `{}`）作纵深。

**Blocked by:** None

**Status:** done — 修复随本票提交（autopilot 4.5.2 changeset）

## 症状（MA runtime 实测，2026-09-20）

gateway 每 ~64s crash loop（`Gateway process exited code=1`），unhandled TypeError，app 自动重启 gateway 无限循环。

## 根因

- 引擎自己持久化的 checkpoint 存在 `ledger: {}`（折叠/清理后的空对象；MA 抓到真实 run 即此形状，复现文件 `x3-runtime-1789908935.json`）。
- restore 路径 `loadCheckpoint` 的 partial 重建 `ledger: cp.ledger` 原样载入，不套 `emptyLedger()` 归一化。
- 之后 stall patrol 读 `l.folded.lastValidatedTurn`、resume_run 注入 `summarizeLedger` 读 `l.entries.map` → undefined TypeError。patrol 在 timer 回调里抛 = 整 gateway 进程崩。
- 纵深缺口：`progress-ledger` 公开函数的 `?? emptyLedger()` 只防 `undefined` 不防 `{}`。

## 修复

1. **根因**：`normalizeLedger`（progress-ledger.ts）—— 完整 ledger 无损透传，空/部分对象补 `folded`/`entries` 缺省，保留未知字段（如 migrateCheckpoint 的 `progressGrace` 标志）；`loadCheckpoint` 改用。
2. **纵深**：`coerceLedger` —— 4 处 `?? emptyLedger()`（summarizeLedger/lastProgressTurn/consumeMigrationGrace/buildProgressHeadline）统一升级。
3. schemaVersion 不 bump（形状向后兼容，完整 ledger 无损）。

## 验收

- [x] `ledger:{}` checkpoint → loadCheckpoint 返回完整 ledger（folded/entries 缺省 + 消费函数不抛）
- [x] 完整 ledger 经 normalize 无损（folded.turns/lastValidatedTurn/entries 保留）
- [x] F3 `progressGrace` 标志经 normalize 保留（migration 测试仍绿）
- [x] MA 侧 fixture 端到端已验（resume_run 成功、cross_turn_resume_consumed 消费 flag、checkpoint 回写盘上）

## 参考

MA 会话 matrixassistant-78 运行时取证（4.5.1 dist `state-persister.js:397` + `progress-ledger.js:105-118`）；发现渠道：MA X3 ② 升级 4.5.0 后的 runtime 实测。
