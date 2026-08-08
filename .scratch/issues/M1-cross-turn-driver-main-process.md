# M1 — 跨轮驱动移入主进程

**仓**: MatrixAssistant
**缺口**: P0-7（跨轮驱动依赖渲染进程）+ P0-1b（空消息四跳 bug）
**阻塞**: 无 —— **可立即开工**，与引擎侧并行
**设计文档**: §5.10、§4 P0-7、§4 P0-1b

---

## 做什么

把跨轮驱动从渲染进程移到 Electron 主进程。**单驱动，不是双驱动**。

### 新增：主进程驱动器

照 `electron/utils/todo-executor.ts` 的形状（那是仓内已有的同形先例）：

- 订阅 `sessions.changed`（或复用 `electron/main/ipc/gateway-handlers.ts` 既有分发点——事件本来就先到主进程，`packages/gateway/src/manager.ts:1589`）；
- `needsCrossTurnResume` 为真时发 `gatewayManager.rpc('chat.send', ...)`（`manager.ts:1351`）；
- **消息体必须非空**——gateway 对空 `message` 直接拒绝（`build/openclaw/dist/chat-CYQVDnLG.js` 偏移 72116，`"message or attachment required"`）。这是 P0-1b 的根因；
- 幂等键**沿用现有构造**：`autopilot-cross-${sessionKey}-${totalContinuations}`。

### 删除：渲染侧驱动

- `src/stores/autopilot-continuous.ts:101-114` 的「3 次即永久 degraded」
- 同文件 `:129-142` 的 `chat.send` 调用

**P0-1b 随之消失**，不需要单独修（那个 bug 的第 3、4 跳都在被删的代码里）。

## 依赖：零 OMM 依赖，可立即开工

本 ticket 消费的两个投影字段**当前已存在**，不需要引擎侧先改：

- `needsCrossTurnResume`（`resources/claw-plugin/autopilot/dist/src/projection.d.ts:11`）
- `totalContinuations`（同文件 `:6`）

⚠️ **崩溃恢复补 kick 不在本 ticket**——`index.ts:500-503` 那个空 if 块 + TODO 在 **oh-my-matrix**，是引擎侧的活，已拆到 [E11](E11-crash-recovery-kick.md)。两者互补但**不互相阻塞**：M1 让活着的 run 能跨轮，E11 让崩溃恢复的 run 被踢起来。

## ⚠️ 必须在代码注释里锚定的约束

**幂等键必须继续从 `totalContinuations` 派生。**

这不是风格偏好——`5.6 → M1` 的前置关系之所以能解除，整个论证就建立在这一点上（设计文档 §7「实施顺序」）：四个 `incrementTotal` 写点全在 turn 完成路径，stall/retry 分支不碰该计数，所以 stall 误报时键不变、被 gateway 去重。

**改成时间戳、随机数或独立递增序号，论证立即失效，双 turn 并发风险重新打开**（gateway 无 session 级串行化，两个不同键会各起一个 turn 同写工作区）。注释里要写明这个因果，不能只写「别改」。

## 为什么是升级不是妥协

v1 认为「渲染进程驱动是 host 能力边界」——**那半句是错的**。host 证据只证明*引擎自己*不能起 turn，没证明必须是渲染进程。主进程三项更优：

| | 主进程 | 渲染进程 |
|---|---|---|
| 事件到达 | 先到（`manager.ts:1589`） | 后到（转发，`gateway-handlers.ts:615`） |
| 断线重放 | ✅ `chat.send` 在 `REPLAYABLE_RPC_METHODS`（`manager.ts:212`） | ❌ |
| 窗口隐藏/渲染节流 | 不受影响 | 受影响 |

## 验收

- [ ] `needsCrossTurnResume` 为真时主进程发出 `chat.send`，**渲染层不再发**（回归测试防旧驱动残留双发）
- [ ] 断线重连后按 `idempotencyKey` 只重放一轮
- [ ] 消息体非空，不被 gateway 拒绝
- [ ] 幂等键约束写进代码注释（含因果，非仅禁令）
- [ ] 渲染侧驱动代码已删除，无残留调用点
- [ ] **真实多轮会话验证**——单测全绿不算数，P0-1 的教训就是 861 个测试全绿而功能从未工作
