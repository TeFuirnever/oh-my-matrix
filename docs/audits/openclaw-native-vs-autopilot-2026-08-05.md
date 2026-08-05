# OpenClaw 2026.7.1-2 原生能力 vs autopilot 重复建设审计

**日期**: 2026-08-05
**审计人**: lead + 4 agent review team（r1-source-fidelity / r4-coverage-gap / r5-inline-attack / r6-citation-forensics）
**基线**: openclaw `0790d9f593` = 2026.7.1；CHANGELOG 顶条 2026.7.1-2 · oh-my-matrix `b39deb6` autopilot v3.1.0
**关联文档**:
- 完整审计报告: `MatrixAssistant/.omc/research/openclaw-native-vs-autopilot-audit.md`
- 设计文档: `MatrixAssistant/docs/core/autopilot/long-horizon-autonomy.md`

---

## 核心结论

1. **原生 goal + token budget 存在**（`src/config/sessions/goals.ts` 332 行），但 token budget 是**纯 advisory 不刹车**：`budget_limited` 全仓 6 处引用，零处拦截执行。E2（刹车）是真缺口。

2. **OpenClaw 原生有插件同步阻断工具门 `before_tool_call`**（`hook-before-tool-call-result.ts:14` `block?: boolean`；`host-tool-param-parsers.ts:26`「runs synchronously inside the hot path」）。E4/E7 的 evidence gate 用这个实现，不是自建。

3. **Task Flow 子系统被整体遗漏**（`runtime-taskflow.types.ts:74-137`，`setWaiting/resume/finish/fail/runTask` + `expectedRevision` 乐观并发 + SQLite 持久化）。E1/E8 实施前须先评估 Task Flow 能否直接承载。

4. **autopilot 对 openclaw 零运行期依赖**（唯一引用是 `import type`，openclaw 只在 dev/peer deps）。goal 功能重复但依赖代价不对称——保留自建，只修 `goal/progress` 快照笔误（`autopilot-state.ts:117-133`）。

5. **「原生能力都卡在两轴之一」的通则被驳倒**。`before_tool_call` + exec-approval 两轴都不失败，18 张 ticket 须逐票自立依据。

---

## 原生能力速查

| 能力 | 原生程度 | 关键路径 | enforcing? |
|---|---|---|---|
| session goal + token budget | 有，advisory | `goals.ts:107-111` | ❌ 只改状态 |
| `before_tool_call` 插件门 | 有，插件一等公民 | `hook-before-tool-call-result.ts:14` | ✅ 同步拦截 |
| exec-approval（shell 命令） | 有，默认 deny | `exec-approvals.ts:299` | ✅ |
| Task Flow（状态机+持久化） | 有，插件可用 | `runtime-taskflow.types.ts:74-137` | ✅ revision 守卫 |
| 成本硬上限 | **无** | — | — |
| 墙钟上限 | 有（默认 48h） | `timeout.ts:12` | ✅ 但阈值形同无 |
| 自动续轮 | **无** | — | — |

---

## Ticket 执行顺序

### 第一批：T0 + MA 零依赖（可立即开工）

| Ticket | 仓 | 说明 |
|---|---|---|
| T0 | — | loop 活性定位（诊断）；结论影响 E2/E4/E6 落地权重 |
| M1 | MA | 跨轮驱动进主进程；`needsCrossTurnResume` 等字段已存在，零依赖 |
| M3 | MA | i18n 穷举映射；映射现有 union，零依赖（E2/E4/E10 新增 reason 时再同步） |
| M4 | MA | 安装期版本错配；零依赖 |
| M5 | MA | 托盘活性；`lastActivityAt` 已存在，零依赖 |

### 第二批：OMM 引擎侧（T0 诊断后开工）

| Ticket | 优先级 | 说明 | 前置 |
|---|---|---|---|
| E9 | P2 | 删死配置 `workflow.workspace.root` | 无 |
| E10 | P2 | 长尾修复 | 无 |
| E12（降级） | 小 | 修 `goal/progress` 快照笔误（`autopilot-state.ts:117-133`） | 无 |
| E3 | P0-3 | 错误分类重做 | 无 |
| E6 | P0-6 | 停滞检测 + 在飞守卫 | T0 诊断 |
| E11 | P1 | 崩溃恢复补 kick | 无 |
| E2 | P0-5 | 墙钟（须证明 48h 不够）+ 成本硬上限 | T0；compaction 边界处理（详见审计 §5A） |
| E4+E7 | P0-4 | evidence gate — 用原生 `before_tool_call` hook 实现 | 无（机制已明确） |
| E5 | P1-11 | 进展台账 | E1/E8 checkpoint 根决定后 |
| E1 | P0-2 | checkpoint 根统一 — **先评估 Task Flow 可行性** | 无 |
| E8 | P3-20 | checkpoint 触发阈值 — 同 E1，先评估 Task Flow | E1 |
| X1 | — | vendor 同步自动化 | 每次引擎 ticket 落地时 |

### 第三批：MA + OMM 跨仓同批

| Ticket | 仓 | 说明 | 前置 |
|---|---|---|---|
| E4 | OMM | （已在第二批）| — |
| M2 | MA | resume 死按钮 — 硬依赖 E4 的 `canResume` 字段 | **E4 必须同批** |

---

## E1/E8 Task Flow 可行性评估要点

在实施 E1/E8 前需回答：

1. `PluginRuntimeTaskFlow.setWaiting({ stateJson })` 能否存储 autopilot checkpoint 的全量字段？
2. `resume({ stateJson })` + `expectedRevision` 是否满足幂等恢复需求？
3. Task Flow 的 `progressSummary` 是否可替代 autopilot 的 `progress` 字段？
4. 接 Task Flow 需要把 openclaw 从 peer/dev 提升为 runtime dep—— 参考审计「依赖成本」结论，决定是否接受。

证明：`/Users/guanxueliang/Desktop/Matrix/社区工程/openclaw/src/plugins/runtime/runtime-taskflow.types.ts:74-137`

---

## E2 实施注意

- 成本上限：OpenClaw 无自有上限，自建。读数应接原生 `tokensUsed`（`session-cost-usage.ts`）。
- 墙钟：原生默认 48h（`timeout.ts:12`）。须论证为何不够（如不可按 goal/run 粒度配置），否则墙钟那半是重复建设。
- **⚠️ compaction 盲区**：原生 auto-compaction 可能中途触发，改变 `tokensUsed` 基线。实现时须订阅 `before_compaction`/`after_compaction` hook 重置基线，否则 token 账在 compaction 后漂移。

---

## E4/E7 实施路径（review 修正）

不是自建 Default-FAIL 机制，而是**用 OpenClaw 原生 `before_tool_call` hook**：

```ts
// packages/autopilot/src/ — 注册 before_tool_call hook
beforeToolCall: async (event, ctx) => {
  if (shouldBlockThisTool(event.toolName, getEvidenceState(ctx.sessionKey))) {
    return { block: true, blockReason: 'evidence-gate: completion not verified' };
  }
  // requireApproval 变体（带超时和用户决策）:
  // return { requireApproval: { title: '...', timeoutBehavior: 'deny' } };
}
```

`block: true` 同步拦截工具调用。`hook-before-tool-call-result.ts:12-28` 是插件面完整类型。

---

## 引用取证汇总（来自 r6）

| 来源 | 结果 | 关键 |
|---|---|---|
| [Claude docs task-budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets) | ✅ REAL | 标题就是「Task budgets are advisory, not enforced」 |
| [anthropics/cwc-long-running-agents](https://github.com/anthropics/cwc-long-running-agents) | ✅ REAL | 611 star 公开仓；Default-FAIL + fresh-context evaluator + 三层持久化逐字对上 |
| arXiv 2511.21572（BAMAS） | ❌ MISQUOTED | 是模型选择降成本论文，非「cumulative token tracking」 |
| arXiv 2511.03690 | ❌ WRONG_DATE | ID=2511（2025-11），报告标 2026-04 |
| arXiv 2601.08815（Agent Contracts） | ❌ MISQUOTED | 是多 agent 预算委派守恒律，非「单调用约束迫使 orchestrator 累计」 |
| 总计 | 7 REAL / 6 MISQUOTED / 1 WRONG_DATE / 0 FABRICATED | 核心两条为真，E2/E4 论点不动摇 |
