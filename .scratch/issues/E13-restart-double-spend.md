# E13 — P3-29 网关重启后双花预算：crash-recovery 不再靠 flag 隐式续行

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P3-29（新增 2026-08-08 第三轮 code-review 取证）
**被阻塞**: E11（同一 crash-recovery 恢复路径——E11 先补 kick，本票再改续行信号机制，避免在同一代码段上互相冲突）
**设计文档**: §4 P3-29；关联 §7 幂等键论证、§10.6

> 建议在 E12 之后做：两者都动 `needsCrossTurnResume` / reducer 区，E12 先把 setter 折平能减少本票的合并冲突。非硬依赖。

---

## 问题

crash-recovery 把 `needsCrossTurnResume=true` 重水合进 `stateByRun`；网关重连后 pull-based projection 重广播带该 flag 的 `sessions.changed` → MA driver 收到**新鲜 `seenAt`**，用**同一 idempotency key** 再发 `chat.send`。

但 openclaw 的去重 Map 是**内存态**（网关重启即清空，LRU 1000 条、TTL 5min，恰等于 plugin `stallTimeoutMs`）；MA 的 24h `processedDedupeHistory` 只覆盖 queued-then-flushed 路径，**不覆盖 direct send**。故网关重启后：同 key 的去重已失效 → **第二个真 turn 跑起来**（双花模型预算）。且每次重复都 `success`，failure 熔断**永远看不到**。

根因：续行靠 flag 重广播**隐式**驱动，而非 driver/host 的**显式**协调。

> 触发前提：M1/§5.10 已于 8-08 落地（主进程单驱动发非空占位）。修复前该路径不可达（空消息先被拒），修复后即成真实风险——本票是 M1 落地后的偿债。

## 做什么（OMM 侧）

采用 design §P3-29 **方向 1**：crash-recovery 不再靠重置/重广播 `needsCrossTurnResume` 隐式续行，改用**显式 resume RPC（带原 runId）**让 driver/host 确定性协调单发。具体：

- 恢复路径不把 `needsCrossTurnResume=true` 当作「重广播即续行」的触发器；
- 引擎侧**提供并处理**该显式 resume RPC（带原 runId），使续行由一次确定的 RPC 驱动，而非 flag 重广播的副作用；
- 保留 `needsCrossTurnResume` 作为**状态事实**（run 处于跨轮未完成），但切断它「隐式再驱动一次 turn」的链路。

**不在本票范围**（design 另两个方向）：方向 2「去重持久化」（openclaw 侧，代价高）；方向 3「MA driver 持久化已发 key」（MA 侧缓解，非根因修）。

## 验收

- [ ] crash-recovery 恢复的 run 不再因 flag 重广播而隐式再发 turn（单测 / reducer 测试覆盖）
- [ ] 引擎侧显式 resume RPC（带原 runId）就位并被处理；续行由该 RPC 驱动
- [ ] 幂等键仍从 `totalContinuations` 派生的不变量不被破坏（见 §7 实施顺序警告——若改键派生方式须在代码注释锚定）
- [ ] 全量 `pnpm verify` 绿
- [ ] ⚠️ 端到端「网关重启无双花」需 **MA driver 侧消费该 resume RPC**——MA 侧改动不在本票范围，列为跨仓依赖（见 README「明确不做/跨仓依赖」）
