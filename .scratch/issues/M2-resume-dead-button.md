# M2 — resume 死按钮修正

**仓**: MatrixAssistant（渲染层，**一行条件**）
**缺口**: P1-8 的用户可见面
**阻塞**: 无
**被阻塞**: **必须与 E4 同批上线**（跨仓同批）
**设计文档**: §5.12 必做 1、§5.4 第三步、§7 迁移表

---

## 为什么这张不能省

E4 第三步让 resume 尊重守门——非可恢复的 blocked 会被 RPC 明确拒绝。这是本轮**唯一减少用户可用操作**的变更。

问题在于按钮**照样显示**：

- resume 按钮的显示条件只有 `isPaused`（`src/pages/Chat/components/ContinuousModeToggle.tsx:168`）；
- 而 `deriveStatus` 把**不可恢复的 blocked 也派生成 `paused`**（引擎 `orchestrator.ts:60`，即审计 3.12 的「死胡同状态」）。

所以 E4 单独上线后：按钮在 → 用户点 → RPC 拒绝 → 弹一句泛化的 `autopilot.error.resumeFailed`（`:105`）→ run 不动。**用户得到一个永远点不动的按钮，比现状更糟。**

v1 把这个问题交给运行面板兜底。面板已撤销（设计文档 §8.1），故改由本 ticket 承担——**且成本更低**。

## 做什么

把按钮显示条件从 `isPaused` 换成 `canResume`（E4 在 `src/projection.ts` 透出，由 `RESUMABLE_BLOCKED_REASONS.has(blockedReason)` 计算）。

不可恢复时按钮**不渲染**。用户看到的是终止原因——`blockedReason` 那行**已经在渲染**（`ContinuousModeToggle.tsx:207-209`），不需要新增 UI。

顺带：这让 `canResume` 有了真实消费点。不做本 ticket 的话，E4 新增该字段即成死字段。

## 验收

- [ ] `blockedReason` 不可恢复时 resume 按钮不渲染
- [ ] `blockedReason` 文案仍渲染（这是唯一的用户可见出口）
- [ ] 可恢复时按钮照常显示且 resume 生效
- [ ] 测试落点 `tests/unit/autopilot/continuous-mode-toggle.test.tsx`
- [ ] CHANGELOG 标 minor，写明「以前能点现在不能点」的行为变更

## 依赖说明

`canResume` 字段来自 E4。若 E4 未落地，本 ticket 可先写测试（红），或临时用 `RESUMABLE_BLOCKED_REASONS` 在渲染侧自算——**但不建议**，会造成两侧各有一份可恢复性判定，正是 P1-8 那个洞的成因。等 E4。
