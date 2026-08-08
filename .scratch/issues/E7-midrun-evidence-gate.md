# E7 — 中途 Evidence Gate

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P0-4 放大因素
**被阻塞**: **E6**（见下方警告）
**设计文档**: §5.7

---

## 做什么

`index.ts:603` 的 `runValidationCommands` 从「只在 `complete` 分支跑」改为「每 N 轮 + `complete` 跑」。

把「最后才发现全错」变成「早期纠偏」。

- **复用**现有 `runValidationCommands` + `evaluateEvidence`，不新造执行路径；
- 中途失败**不 block**，只把 stderr 经已有的 `buildFailureBlock`（`continuation-engine.ts:157-183`）回注下一轮；
- 按 **turn 数**而非时间节流——validation 可能很慢，按时间会在慢命令上叠加。

## ⚠️ E6 必须先于本 ticket

中途 validation 会拉长「在飞」时间。**没有 E6 的在飞守卫，中途 gate 本身就会触发 stall 误报**——即这个方案会制造它想解决的问题。

顺序不可颠倒。

## ⚠️ 与 E2 成本上限相互作用

中途 validation 也耗时，N 太小会显著拉长总时长、更快撞上墙钟上限。建议 **N ≥ 5 且可配**。

## 验收

- [ ] 每 N 轮执行一次 validation，`complete` 时仍执行
- [ ] 中途失败不 block，只回注 stderr
- [ ] 按 turn 数节流，非时间
- [ ] N 可配且默认 ≥ 5
- [ ] 中途 validation **不触发** stall 误报（依赖 E6，需专项验证）
