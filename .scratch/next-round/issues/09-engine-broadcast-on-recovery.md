# 09 — 引擎 crash-recovery 后广播 sessions.changed（解锁 08 重启路径）

**What to build:** 插件在 crash-recovery 完成后，对每个从 checkpoint 恢复的活跃 session 广播一次 `sessions.changed` 通知——让 MA 宿主通过已有的事件路径重建 `activeSessions`，从而使 `resumeRestoredRuns` 在 app 重启后能正常触发。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

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

## 为什么需要这张 ticket

MA 宿主的 `resumeRestoredRuns`（`electron/utils/autopilot-cross-turn-driver.ts:175`）依赖 `activeSessions` Map，而这个 Map 由 `sessions.changed` 事件填充。app 重启后 Map 是空的，`resumeRestoredRuns` 遍历空集合，crash-recovery 的恢复 run 不会被续行。

引擎插件已经在 gateway 启动时从 checkpoint 恢复了 `stateByRun`（vendored plugin `:619-644`），数据在引擎侧是完整的——缺的只是一次通知。

这张 ticket 的改动在 OMM `packages/autopilot/src/index.ts` crash-recovery 段（对应 vendored `:606-644`），MA 侧只需确认 `gateway-handlers.ts:583` 的守卫在首次启动时覆盖 `previousGatewayState === undefined` 的情况（或移除该守卫），见 `next-round/08` 的说明。

## 参考

crash-recovery 段：vendored `resources/claw-plugin/autopilot/dist/index.js:606-644`；OMM 源码 `packages/autopilot/src/index.ts`。MA 宿主消费路径：`electron/utils/autopilot-cross-turn-driver.ts:404-545`（`handleCrossTurnResume`）+ `gateway-handlers.ts:583`（`resumeRestoredRuns` 调用点）。
