# E2 — 墙钟 + 成本硬上限

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P0-5
**被阻塞**: **T0**（判定落点取决于 T0 结论）
**同批**: **E3 必须与本 ticket 同批** —— 否则「更能活」而「无刹车」
**设计文档**: §5.2

---

## 问题

默认配置**没有成本硬顶**。唯一普适刹车是 `maxTotalContinuations = 50`，每次可烧一整轮 token。无墙钟上限、无默认 token 预算。且 token 预算只在 turn 边界检查——**单轮内部可超支任意多**。

业界共识是三类预算**并联**任一触发即熔断（迭代 + 墙钟 + 成本），单看轮数在「每轮都很贵」场景失效。

## 做什么

`AutopilotConfig`/`AutopilotState` 增 `maxDurationMs?`、`maxCostUsd?`，判定复用现有 `tokenBudget` 形状（`continuation-engine.ts:84-86`）。

### ⚠️ 落点：主判定必须在 60s 巡检，不在 `decideContinuation`

`before_agent_finalize` 在 API 错误时不触发，且 P0-1 显示该 hook 在 MA 真实 runner 下的触发本身存疑。

> **主判定落 60s 巡检**（`index.ts:1407-1472`），与 stall 检查并列。`decideContinuation` 内的判定退为辅助快速路径。

巡检本就是**唯一能在 turn 内部介入**的位置——这顺带解决了「拦不住单个超长 turn」。

### ⚠️ 新 PauseReason 必须同步四处

`max_duration_reached`、`max_cost_reached`，映射为**非** resumable（对齐 `token_budget_exceeded`）：

| # | 位置 | 漏改后果 |
|---|---|---|
| 1 | `PauseReason` union（`types.ts:3-13`） | 编译错误，会被发现 |
| 2 | `pauseReasonToBlockedReason`（`types.ts:88-105`，total 映射） | 编译错误，会被发现 |
| 3 | `BlockedReason` union（`types.ts:26-45`） | 编译错误，会被发现 |
| 4 | **`VALID_BLOCKED_REASONS` Set**（`types.ts:48-66`） | **静默降级**——reason 丢失变成通用错误。前三处编译器兜底，**只有这处不会报错** |

**MA 侧 M3 也要同步**（i18n 穷举映射），否则新状态在 UI 显示为裸 code。

### ⚠️ 与 TENSION 3 的交互：硬上限会被静默吞掉

`pause_requested` 在 `retry_queued` 状态下是 **no-op**（`orchestrator.ts:333-341`，故意设计——recoverable breaker 要能活过一次 pause）。

若巡检在 run 处于 `retry_queued` 期间触发硬上限，**pause 被吞，上限在整个 retry 窗口内无效**。硬上限须走一条**不受 runningFamily 限制的独立终止事件**。这条最容易漏。

### 其余

- 成本公式从 `projection.ts:53-71` 抽成 `src/cost.ts` 纯函数，投影与判定共用，避免第二套定价常量；
- **受控收尾**：任一上限触发时先注入「收尾并汇报现状」指令再 pause，而非直接 pause。用户拿到现状摘要而非静默停止的 run；
- 恢复路径保留配置值——消除 `state-persister.ts:291,300-302` 的硬编码 5。

## ⚠️ 已知限制，须写进文档

成本判定依赖 host 上报 usage。host 不报时 `totalTokensUsed` 恒 0（已有一次性告警 `index.ts:941-944`）。**§2.7 那个真实 run 正是 `totalTokensUsed: 0`**——这不是理论顾虑。文档须写明「成本上限在 host 不报 usage 时为 no-op」，不可当硬保证。

## 验收

- [ ] 墙钟与成本上限在 60s 巡检中生效
- [ ] `retry_queued` 期间触发硬上限**不被吞掉**（专项测试）
- [ ] 四处 reason 同步完成，含 `VALID_BLOCKED_REASONS`
- [ ] 单个超长 turn 能被巡检拦住
- [ ] 受控收尾指令先于 pause
- [ ] 恢复路径保留配置值
- [ ] host 不报 usage 的行为有文档说明
- [ ] 与 E3 同批上线
