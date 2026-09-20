# 09 — 引擎 crash-recovery 后广播 sessions.changed（解锁 08 重启路径）

**What to build:** 插件在 crash-recovery 完成后，对每个从 checkpoint 恢复的活跃 session 广播一次 `sessions.changed` 通知——让 MA 宿主通过已有的事件路径重建 `activeSessions`，从而使 `resumeRestoredRuns` 在 app 重启后能正常触发。

**Blocked by:** None — can start immediately.

**Status:** done — afd5d4b + 87d4935（pull RPC）；方案 B 广播 2026-09-20 补齐（见实现说明②）

- [x] crash-recovery 后通知宿主哪些 session 有活跃 run（用 pull RPC 替代 push broadcast，见实现说明）
- [x] 返回内容包含 `status`、`needsCrossTurnResume`、`totalContinuations`（MA 宿主消费所需字段）
- [x] 无活跃 run 时 RPC 返回空列表，不影响现有「无 crash-recovery」路径
- [x] 不破坏现有路径：测试覆盖"无 run 时返回空列表"和"terminal run 被排除"两个场景

## 实现说明（2026-09-18）

`api.broadcast('sessions.changed', {...})` 在 openclaw v2026.7.1 里不存在。`sessions.changed` 由 gateway 内部的 `emitSessionsChanged` 函数发出（需要 `GatewayRequestContext`），插件侧无法直接调用。

等价实现：新增 `autopilot.list_resumable_sessions` 拉取式 RPC（`packages/autopilot/index.ts`），返回：
```json
{ "sessions": [{ "sessionKey", "status", "needsCrossTurnResume", "totalContinuations" }] }
```
只包含活跃 orchestration state（`running / claimed / retry_queued / released / unclaimed`）的 run。

**MA 宿主侧需做（ticket-08）**：在首次 gateway 连接时调用 `autopilot.list_resumable_sessions`，用返回的 `sessions` 填充 `activeSessions` Map，然后调用 `resumeRestoredRuns`。同时确认 `gateway-handlers.ts:583` 的 `&& previousGatewayState` 守卫覆盖 `previousGatewayState === undefined`（首次启动路径）。

commits: `afd5d4b`、`87d4935`（后者提取了 `isActiveOrchestrationState` 消除重复状态判断）

## 实现说明②（2026-09-20 · 方案 B 广播落地）

MA X3 拍板的方案 B 已落地，形态是 **pull 触发的 push**：

- **init 即时推送物理不可能**（两个独立事实）：activate 时不存在 `GatewayRequestContext`；且首个 MA 连接建立前订阅者 connIds 为空，gateway 自己的 emitter 在 `connIds.size === 0` 时早退——推送无接收者。
- 因此推送**搭宿主的首次 pull**：`autopilot.list_resumable_sessions` handler 现在持有请求级 `GatewayRequestContext`（其上有 `broadcast`——这正是 09-18 结论漏掉的面：不可达的是 activate 时的 api，不是 handler ctx），respond 前对每个 advertised session 广播一条 `sessions.changed`。
- payload：`{ sessionKey, ts, pluginExtensions: { autopilot: { status, needsCrossTurnResume, totalContinuations, maxTotalContinuations, lastActivityAt? } } }` —— `pluginExtensions.autopilot` 形状与 gateway 自发广播一致（extractAutopilotExt 兼容形状之一）。
- **broadcast 列表 == response 列表**（同一数组，同一组守卫：无 sessionKey 跳过、enabled=false 跳过）。
- response 同步补 `maxTotalContinuations` + `lastActivityAt`（有则带）两个加法字段，MA 守卫消费的 totalContinuations 数值保证不变。
- 幂等：恢复只在 process init 一次；宿主重复 pull → 重复广播被 MA 侧 idempotencyKey 去重，无害。
- 语义边界不动：广播是数据不是 kick（"Continuation is now EXPLICIT"）；stall fallback 保留。

**MA 侧验收路径**：模拟 crash-recovery 后首次连接调 `autopilot.list_resumable_sessions` —— response 列表之外，每个恢复 run 应收到一条带 `pluginExtensions.autopilot` 的 `sessions.changed`；`totalContinuations` 数值型。

## 为什么需要这张 ticket

MA 宿主的 `resumeRestoredRuns`（`electron/utils/autopilot-cross-turn-driver.ts:175`）依赖 `activeSessions` Map，而这个 Map 由 `sessions.changed` 事件填充。app 重启后 Map 是空的，`resumeRestoredRuns` 遍历空集合，crash-recovery 的恢复 run 不会被续行。

引擎插件已经在 gateway 启动时从 checkpoint 恢复了 `stateByRun`（vendored plugin `:619-644`），数据在引擎侧是完整的——缺的只是一次通知。

这张 ticket 的改动在 OMM `packages/autopilot/src/index.ts` crash-recovery 段（对应 vendored `:606-644`），MA 侧只需确认 `gateway-handlers.ts:583` 的守卫在首次启动时覆盖 `previousGatewayState === undefined` 的情况（或移除该守卫），见 `next-round/08` 的说明。

## 参考

crash-recovery 段：vendored `resources/claw-plugin/autopilot/dist/index.js:606-644`；OMM 源码 `packages/autopilot/src/index.ts`。MA 宿主消费路径：`electron/utils/autopilot-cross-turn-driver.ts:404-545`（`handleCrossTurnResume`）+ `gateway-handlers.ts:583`（`resumeRestoredRuns` 调用点）。
