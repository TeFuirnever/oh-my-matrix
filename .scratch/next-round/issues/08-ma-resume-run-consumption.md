# 08 — MA 宿主 resume_run 消费（P3-29 全闭合）

**What to build:** 宿主驱动改为显式调用 `autopilot.resume_run`（E13 RPC）消费跨轮续行——gateway restart 不再靠 flag 隐式 re-broadcast，P3-29 double-spend 全链路闭合。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 宿主恢复 mid-cross-turn run 时调用 resume_run（一次）
- [ ] 幂等（重复调用不双 kick——gateway resume 已清 needsCrossTurnResume）
- [ ] 回归：重启窗口无双 spend

## 参考
E13/P3-29 文档（index.ts resume_run 注释）；omm-implementation-status E13 行。

## Comments

### 2026-09-18 — 缺失的数据源：`autopilot.status` 已发布但从未被调用

本票的三条验收在**网关重连**路径上可满足（`gateway-handlers.ts:584` 已调 `resumeRestoredRuns`），但在 **app 重启**路径上无法触发，原因是宿主没有 run 台账可遍历：

- `activeSessions` 是纯内存 `Map`（`electron/utils/autopilot-cross-turn-driver.ts:130`），**不落盘**，进程退出即空
- `resumeRestoredRuns`（`:175-182`）遍历该 Map，重启后集合为空，循环体一次都不执行
- 代码注释自述了这个设计（`:170-174`）：「E13 deleted register()'s auto-kick, so restored runs sit silently until this RPC or stall fallback」—— 但重启后没有任何东西驱动那个 RPC

**数据源已经存在，只是没接**：已 vendor 的插件（`MatrixAssistant/resources/claw-plugin/autopilot/dist/index.js`）注册了 6 个 RPC：

```
autopilot.activate   autopilot.cleanup    autopilot.resume
autopilot.resume_run autopilot.status     autopilot.stop
```

宿主实调 4 个（`activate` / `resume` / `resume_run` / `stop`）。**`autopilot.status` 和 `autopilot.cleanup` 全仓零调用点** —— `autopilot.status` 的两处字符串命中都是 i18n key（`autopilot-cross-turn-driver.ts:269` 的 `tray.autopilot.status`、`ContinuousModeToggle.tsx:135` 的 `autopilot.status.done`）。

`autopilot.status` 返回投影（`docs/core/autopilot/design.md` 的 Gateway RPC 表；引擎侧语义见 `packages/autopilot/src/progress-ledger.ts:237`：「state.progress is returned verbatim by the autopilot.status RPC」）。

**重要：`autopilot.status` 无法解决重启场景的数据源问题**

2026-09-18 实读发现 `autopilot.status` RPC 需要传入 `sessionKey` 才能返回有效数据（vendored plugin `:1754-1770`），而 app 重启后 `activeSessions` 是空 Map，没有可查的 sessionKey——调用 `autopilot.status` 在重启路径上是空操作。

**引擎侧在 gateway 启动时确实从 checkpoint 恢复了数据**（vendored plugin `:619-644`，`loadCheckpoint` + `stateByRun.set`），问题是宿主侧不知道引擎恢复了哪些 session。

**两个实现路径的权衡**：

**方案 A（MA 侧读 checkpoint，可在本票实现）**：gateway 首次 `running` 时，直接从 `~/.matrix/.autopilot/checkpoints/` 读所有 `.json` 文件，提取 `sessionKey` + `needsCrossTurnResume`，填入 `activeSessions`，再调 `resumeRestoredRuns`。`AutopilotCheckpoint` 有 `schemaVersion` 保护（`packages/autopilot/src/state-persister.ts:116-131`），两个字段稳定。缺点：在 MA 和 OMM checkpoint schema 之间建立新的隐式耦合，MA 绕过了 RPC 层直接读引擎内部存储。

**方案 B（OMM 侧 crash-recovery 后广播 sessions.changed，需新建 OMM ticket）**：在引擎插件 crash-recovery 完成后（vendored plugin `:644`，`stateByRun.size > 0` 时），对每个恢复的 session 广播一次 `sessions.changed`，MA 宿主通过已有的 `updateAutopilotTrayStatus` + `handleCrossTurnResume` 路径正常接收。不新增耦合，是两侧架构意图最自然的扩展点。缺点：需要 OMM 侧改动，ticket 08 单独不能完成。

**建议**：先建 OMM 侧 ticket（已建为 `next-round/09-engine-broadcast-on-recovery.md`），本票等 09 落地后 MA 侧只需确认 `gateway-handlers.ts:583` 的守卫在首次启动时也覆盖 `previousGatewayState === undefined`（即把 `&& previousGatewayState` 守卫改为覆盖首次连接路径）。若决定走方案 A，在本票里实现 checkpoint 读取逻辑，同时移除那个守卫。

**影响面**：不修时，长程任务在 app 重启后宿主侧不可见，跨轮续行在此期间不发生，直到 Agent 侧下一次自发事件；长 turn 下该窗口可达 ~20min（`autopilot-cross-turn-driver.ts:186-190` 自述同一数量级）。

**`Blocked by: 05` 版本号过期**：MA 现已 re-vendor 4.4.1（`2af2d461c`），05 的 `bundle:openclaw 重建` + smoke 两项仍需核实，但不阻塞方案 A/B 的开发阶段验证（dev 路径走 `node_modules`）。
