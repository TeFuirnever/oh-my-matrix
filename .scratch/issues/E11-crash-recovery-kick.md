# E11 — 崩溃恢复补 kick

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P0-7 的恢复路径分支
**被阻塞**: 无
**设计文档**: §5.10 末条

> 从 M1 拆出。M1 写成了 MA ticket 的一部分，但代码在引擎侧——**这是仓归属修正，不是新增范围**。

---

## 问题

`register()` 恢复 checkpoint 时，`needsCrossTurnResume` 为真的 run 有一个**空的 if 块**（`index.ts:500-503`）：

```ts
if (restored.needsCrossTurnResume) {
  // A restored run that was mid-cross-turn needs a kick to restart the
  // agent loop; defer to kickResumedTurn once enqueueInjectionFn is set.
}
```

注释说「推迟到 `enqueueInjectionFn` 就绪后再 kick」，但**没有任何代码实现这个推迟**。净效果：崩溃恢复的 `claimed` run 不会被自动踢起来，只能等下一次 stall/retry tick 或会话重连。

## 做什么

实现注释描述的语义：`enqueueInjectionFn` 就绪后主动对这些 run 补一次 kick，而非等 tick。

## 与 M1 的关系

**互补，不互相阻塞**：

| | 覆盖场景 |
|---|---|
| M1（MA 主进程驱动器） | 活着的 run 跨轮 |
| **E11**（本 ticket） | 崩溃/重启恢复的 run 被踢起来 |

⚠️ **但 M1 落地前 E11 的效果有限**：kick 最终仍要靠外部派发 turn（`enqueueNextTurnInjection` 结构上无法启动 turn，见 P0-7）。E11 让恢复的 run 进入可被驱动的状态，M1 提供驱动。建议 M1 之后验证 E11 的端到端效果。

## 验收

- [x] `needsCrossTurnResume` 为真的恢复 run 在 `enqueueInjectionFn` 就绪后被 kick
- [x] 空 if 块不再存在（已实现：restore 循环内调 `kickResumedTurn`，其自带 `orchState==='claimed'` 守卫）
- [ ] 与 M1 组合后端到端续跑 —— **MA 侧验证，OMM 范围外**；OMM 侧已用 2 个集成测试钉死（恢复的 needsCrossTurnResume run 被 kick；无该 flag 的 claimed run 不被 kick）

## 状态（2026-08-08 实施完成）

commit `41d9d79`（branch `autopilot-engine-e11-e12`）。`enqueueInjectionFn` 在 restore 循环之前就绪（register line 459 < 488），故直接 kick，不等 stall/retry tick。

⚠️ **E13 (P3-29) 交互**：本 kick 是一条新的跨轮 send 路径。网关重启后去重 Map 清空，E13 须把这条路径纳入「无双花」加固（代码注释已锚定）。
