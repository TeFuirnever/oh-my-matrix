# E8 — checkpoint 触发与阈值修正

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P3-20（turn 计数回退）+ P1-9（degraded 路径丢增量）
**被阻塞**: 无
**设计文档**: §5.8

---

## 1. checkpoint 触发不再搭便车（P3-20）

`shouldCheckpoint`（`index.ts:218-229`）加：

```ts
if (prev.totalContinuations !== next.totalContinuations) return true;
```

当前 turn 计数靠 `progress` 字段变更**搭便车**落盘——脆弱。

## 2. 修 P1-9：degraded 路径丢增量

`agent_end` canary 分支算出 `continued = incrementTotal(resetTurnAttempts(updated))`（`index.ts:1039`），但**只在 enqueue 成功时写回**。enqueue 缺失或抛错时走 `setState(runId, { ...updated, needsCrossTurnResume: true })`（`:1073`）——`updated` 从未 `incrementTotal`。

**三条出口有两条不递增。** 后果：唯一普适刹车（turn 计数）在降级模式下可能永不递增 → 叠加 P0-5（无墙钟上限）**降级模式的 run 没有任何硬性终止条件**。

修法：两条丢增量出口改为写 `continued` 而非 `updated`。

⚠️ enqueue 成功分支用的是「重取当前态 + 手动 +1」（`:1053-1063`）。修正后**三条出口的递增语义须一致**——建议统一为重取模式，避免覆盖并发变更。

## 3. 消除硬编码阈值漂移

- `state-persister.ts:303` 的 `toolErrorThreshold: 5` → 持久化真实值，缺失时回落到 `types.ts` 默认常量（当前默认是 3，恢复后变 5 是**静默漂移**）；
- `maxConcurrentAutopilot: 5`（`:291`）同理。

## 4. tmp 残留清扫（P2-18）

`listResumableCheckpoints` 扫目录时顺带删除超过 TTL 的 `.tmp.*` 文件。

## 5. checkpoint 写失败可观测（P2-18）

从 fail-silent 改为经投影透出 `_writeFailureCount`。

⚠️ **面板已撤销**，该字段无渲染消费点。仍应透出（供日志与将来使用），但**不要**在 ticket 里写「UI 在非零时告警」——没有那个 UI。可考虑接入 M5 的异常提醒通道。

## 性能说明

落盘频率上升（每轮一次）。可接受：`totalContinuations` 每轮最多变一次，远低于 `agent_activity` 频率，且写入已有 per-runId 锁与原子 rename。

## 验收

- [ ] turn 计数变更直接触发 checkpoint，不依赖 `progress`
- [ ] `agent_end` 三条出口递增语义一致（专项测试覆盖 enqueue 缺失/抛错两条降级路径）
- [ ] 恢复后 `toolErrorThreshold` 是真实配置值，非硬编码 5
- [ ] tmp 残留被清扫
- [ ] 写失败计数可观测
