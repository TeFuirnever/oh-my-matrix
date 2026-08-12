# 13 — Mid-run validation writeback（/code-review F5）

**What to build:** `runMidRunValidation`（`index.ts:263`）每 `midrunValidationInterval` 轮算出真实 per-turn validation 结果但**丢弃**（不 setState evidence）。把它写回 state，让 evidence-coupled 记账（02）在**首次 gate 前**就可达。

**Blocked by:** 12（F1 stale-stamping 修复后，per-turn evidence 语义才稳——否则 writeback 同样被 stale 覆盖）

**Status:** ready-for-agent（仅记录，未开发）

## 问题（/code-review F5）
- 02 的核心价值："churn 文件但验证不过"的 run trip no_progress
- 但 gate 只在 complete 路径跑。一个**从不 declare complete**（永远 revise）的 churn run：`state.evidence` 恒 `undefined` → 每个 entry 算 progress（`progress-ledger.ts:167` `undefined !== 'failed'`）→ **no_progress 永不 fire**——正是 02 要抓的场景
- mid-run validation 的数据**存在**（每 N 轮算一次）却被丢弃——同一个输入，altitude fix 会消费

## 修法
- `runMidRunValidation` 结果 setState 到 `state.evidence`（带 `skipReason`/来源标记，区分 mid-run vs complete-gate）
- 与 F1（ticket 12）配合：stamp 本轮 entry 时用 per-turn gate 结果（mid-run 或 complete），非 stale `state.evidence`

## 验收
- [ ] churn 文件 + mid-run validation 持续 failed + 从不 complete 的 run → trip no_progress
- [ ] mid-run passed 不误暂停
- [ ] 契约测试：mid-run failed writeback → entry stamp → detector 可达
