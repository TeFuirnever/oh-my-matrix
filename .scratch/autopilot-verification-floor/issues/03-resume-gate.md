# 03 — §5.4b resume 守门 + §5.12 同批

**What to build:** resume 不再恢复不可恢复的 blocked run（行为破坏性变更）。resume 请求被 reducer 拒绝时返回明确错误而非静默继续；resume setter 收缩为只清理副状态；`canResume` 替换恢复按钮的显示条件（与 §5.12 同批落地，否则出现永远点不动的按钮）。CHANGELOG 标 minor 并写明破坏性。

**Blocked by:** 02 — evidence_missing 可达（首个生产写点）后才谈守门

**Status:** ✅ 已实施（2026-08-09 代码核验：`orchestrator.ts:399-419` RESUMABLE 守卫 + REV-1 unclaimed 修复；gateway `index.ts:1622`）

> 实现偏差记录：设计要求"reducer no-op → gateway respond INVALID_REQUEST"；实现改为 `status==='paused'` 前置拒绝（非可恢复 blocked 不派生 paused）+ reducer 内部守门。功能等价，未按设计显式检查 no-op。可选跟进：gateway 显式比对 reducer 结果是否变化。

- [ ] 不可恢复的 blocked run resume → 拒绝 + 明确错误（含原因），不再静默调 setter
- [ ] 可恢复的 blocked（含 evidence_missing）→ resume 成功
- [ ] resume setter 收缩为清理副状态，不再自行写编排状态
- [ ] `canResume` 由可恢复集合计算并透出投影
- [ ] 恢复按钮显示条件切到 `canResume`（同批，防永远点不动的按钮）
- [ ] 既有断言"非可恢复 blocked 也能 resume"的测试更新
- [ ] CHANGELOG minor 标注破坏性
