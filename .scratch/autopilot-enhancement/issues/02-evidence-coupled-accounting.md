# 02 — Evidence-coupled 记账 + receipt 排序

**What to build:** 只有验证通过（evidence passed）的轮才计入 progress；证据→记账严格排序（先验证后记账，fail-closed：validator 抛错/garbage → inconclusive → repair_required）。现在每轮都计 continuation、验证失败也算——修掉。

**Blocked by:** None — can start immediately

**Status:** ✅ 已实施（commit feacd81）— /code-review 发现 3 个 CONFIRMED 回归 → ticket 12 修复

## 已交付（feacd81）
- `lastProgressTurn(ledger)` 纯函数：最近非 `'failed'` evidenceStatus 轮的 turn，fallback `folded.lastValidatedTurn`
- `FoldedAggregate.lastValidatedTurn` 字段 + `foldOldest` carry（validated 进展老化出 detail 窗口后仍可见）
- `index.ts` no_progress detector 用它替换内联（"without validated output" 措辞）
- 7 单测（empty / all-failed / trailing-failed / undefined / folded 交互 / skipped / 全非 failed）

## /code-review 发现（2026-08-11，详见设计文档 §C1）
997 测试绿但 wiring 未测——3 个 CONFIRMED 回归（**未合 master，修最便宜**）：
- **F1** 🔴 stale `'failed'` stamping：gate 只跑 complete 路径，修复轮被 stale evidence 标 failed → no_progress 误暂停修复中 run → 一 turn 一 resume 死循环
- **F2** 🔴 audit refcount over-release：no_progress pause 无 guard 释放 → 并发 run audit monitor 误摘
- **F6** `'skipped'`/`'not_executed'` 算 progress：与 gate fail-closed 矛盾
- **F7** off-by-one：有效阈值 threshold-1
- **F8** 测试 gap：7 测试不测 stamping→patrol 路径，F1 绿通过

→ 全部由 **ticket 12** 修复（仅记录，未开发）。

- [x] 未验证的轮不计入 progress（验证失败轮不算"推进"）
- [x] no-progress 检测与新记账语义一致
- [ ] F1 stale stamping 修复（ticket 12）
- [ ] F2 audit over-release 修复（ticket 12）
- [ ] evidence→记账排序纪律（receipt algebra，ticket 03 范畴）
- [ ] validator fail-closed（ticket 03 范畴）
- [ ] 契约测试：stale-stamping 不误报（ticket 12 F8）
