# 04 — size-classifier（任务形状 → effort 路由）

**What to build:** 按任务形状路由 effort——3 信号（files-touched × new-dep/contract × design-ambiguity）→ 4 tier（trivial/small/standard/large）→ 喂 `resolveThinkingIntensity`（effort-injection.ts）。非规划，仅成本路由。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 分类信号采集（totalContinuations<=1 时分类一次）
- [ ] 4 tier → thinking intensity 映射（trivial→low, small→low/medium, large→high）
- [ ] 与 model-routing 联动（large → premium tier）
- [ ] 测试：4 tier 分类正确性

## 参考
ecc-intake-recommendation.md §3.1 #3（3 信号 4 tier 表已定）；autopilot-verification-floor-design.md T06。
