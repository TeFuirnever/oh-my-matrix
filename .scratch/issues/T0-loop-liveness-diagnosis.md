# T0 — loop 活性定位

**类型**: 调查（**非代码交付**）
**仓**: MatrixAssistant（诊断入口）+ oh-my-matrix（打点）
**阻塞**: E2, E4, E6
**被阻塞**: 无 — **第一张开工的 ticket**
**设计文档**: §5.0、§2.7、§4 P0-1

---

## 为什么它排第一

磁盘上唯一的真实 run 在 `totalContinuations: 0` 时死亡。**没有任何证据表明长程自主 loop 曾真正转动过。** 若 loop 在 MA 真实 runner 下从未转起来，E2 的上限、E4 的判定、E6 的检测就是在给不运行的代码加特性。

这不是「先谨慎一下」，是**已发生的故障** vs **待兑现的风险**的区别（设计文档 §4 P0-1 开头）。

## 做什么

### 步骤 1 — 让插件 INFO 可见（**没有这步，后面全是盲猜**）

三选一，推荐第三个：

| 选项 | 做法 | 代价 |
|---|---|---|
| 零代码 A | 诊断期把 MA logger 级别开到 DEBUG | 日志量大 |
| 零代码 B | `AUTOPILOT_LOG_FORMAT=json` + 关键打点临时改 `warn()` | 需改插件代码 |
| **一行代码（推荐）** | `classifyStdoutMessage` 给 `[autopilot]` / `[mem4claw]` 类插件前缀加 `→ info` 规则 | 一行，且**同时修好所有插件**的可观测性 |

⚠️ **不要**改 `packages/autopilot/src/logger.ts` 让 info 走 stderr——该文件有 DRIFT REFERENCE 约定（`logger.ts:13-19`，须与 `packages/dynamic-workflows/src/logger.ts` 字节等价）。

### 步骤 2 — 打点 `resolveSessionKey` 每 hook 取值

记录 `hook 名 / ctx.sessionKey / event.sessionKey / sessionIdToKey 命中`。顺带验证 P2-19（sessionKey 双源，代码注释自承未审计）。

### 步骤 3 — 打点 `agent_end` 的三个早退守卫

区分「hook 未触发」与「触发但早退」。这是 §2.7 未能定论的分叉点。

### 步骤 4 — 真实会话复现

配 workspace + 发一个需要多轮的任务，观察 `[autopilot]` 日志序列是否出现 `before_agent_finalize` 痕迹。

⚠️ **P0-1b 会挡住复现**：跨轮空消息被 gateway 拒绝，故复现前需先临时发非空占位文本（或先做 M1）。**这条容易踩**——不处理会得到「loop 不转」的假阳性，而真因只是空消息。

## 验收

产出一份结论，明确回答：

1. `before_agent_finalize` 在 MA 真实 runner 下**是否触发**？
2. 若触发，run 匹配是否成功（sessionKey 口径对不对）？
3. 分流结论：
   - **不触发** → 主循环需改挂 `agent_end`（或 host 侧补 hook 派发），且 **E2 的判定落点必须在 60s 巡检而非 turn 边界**
   - **触发但 run 匹配失败** → 修 sessionKey 口径（P2-19），其余方案落点不变

**结论写回设计文档 §4 P0-1**（把「未证」改成已证），并更新 §10.6 的已知边界。

## 完成定义

- [ ] 步骤 1 落地，`[autopilot]` INFO 在 MA 日志中可见
- [ ] 一次真实多轮会话的完整日志序列存档
- [ ] 上述三问有明确答案，写回设计文档
- [ ] E2/E4/E6 的落点确认（或确认无需改动）
