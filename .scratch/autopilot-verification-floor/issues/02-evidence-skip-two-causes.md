# 02 — §5.4a 验收基线：skipped 两因区分

**What to build:** evidence 门把 `skipped` 分成两种成因，各自正确处置：从未配置验证命令（无测试项目是合法场景）→ 完成并打 `completionUnverified` 标记（不拦）；配置了但没跑成（命令缺失/超时/被安全白名单丢弃）→ 进入 blocked 且 `evidence_missing` 可恢复。`completionUnverified` 与可恢复性透出到投影，供上层展示。

**Blocked by:** 01 — 在飞守卫（§5.6）先行，否则收紧的门被损坏的停滞检测反噬（TOCTOU）

**Status:** ✅ 已实施（2026-08-09 代码核验：`orchestrator.ts:257-295` 两因分支 + `evidence-gate.ts:34` skipReason + `orchestrator.test.ts`/`evidence-gate.test.ts` 覆盖）

决策形状（来自设计文档 `autopilot-verification-floor-design.md` §3.1，非本票实现细节——两因用显式字段区分，不靠匹配错误文案字符串）：

```
skipReason: 'not_configured' | 'not_executed'
not_configured → done + completionUnverified
not_executed   → blocked + blockedReason='evidence_missing'
```

- [ ] 从未配置命令 → done + `completionUnverified` 标记（行为不变，仅加标记）
- [ ] 配置了但命令缺失/超时/被白名单丢弃 → blocked + `evidence_missing`（首个生产写点，resumable）
- [ ] 命令全过 → done（行为不变）
- [ ] 求值出错的分支也归入 not_executed 一侧，不漏到 done
- [ ] 两因用显式 `skipReason` 字段区分，不匹配错误文案字符串
- [ ] `completionUnverified` 透出到投影
- [ ] 契约测试：三因（not_configured / not_executed / passed）各得正确终态
