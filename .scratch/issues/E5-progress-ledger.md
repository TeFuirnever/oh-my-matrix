# E5 — 进展台账

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P1-11（压缩后只剩计数串）+ P1-13（子 agent 扇出不透明）
**被阻塞**: **E1**（落盘根须与统一后的根一致）
**设计文档**: §5.5

> 设计文档标注**收益最高**——它是 P1-11 与 P1-13 的共同根因。

---

## 做什么

替换 `"Turn N/M completed"` 这个计数串。新建 `src/progress-ledger.ts`：

```ts
interface LedgerEntry {
  turn: number;
  filesTouched: string[];      // 仅写类工具（workspace_write）
  commandsRun: string[];       // 仅执行类（validation / destructive_git / 未分类 exec）
  evidenceStatus?: EvidenceStatus;
  decisions: string[];         // 模型显式声明的决策（可选，先留空）
  openItems: string[];         // 已知未完成项
}
```

## ⚠️ 数据源精度边界（最容易实现错的地方）

| 源 | 能拿到什么 | 用途 |
|---|---|---|
| `after_tool_call`（`index.ts:669-696`） | `toolName` + `params` —— **唯一**能拿到文件路径/命令文本的地方 | `filesTouched` **必须**从这里取 |
| `permissionAudit`（`index.ts:886-906`，上限 200） | 只有 `toolName`/`commandClass`/`cwd`/`outcome`/`reason` | 只能作**分类信号**，**不能**作 `commandsRun` 文本来源 |
| state 中的 evidence 结果 | 直接取 | `evidenceStatus` |

autopilot 构造 audit entry 时**不填** `commandSummary`（该字段在 `permission-policy/src/types.ts:33` 是 optional）——所以 `permissionAudit` 里没有命令文本。

⚠️ **`permissionAudit` 包含只读调用**：它在 `allow` 判定**之前**就为每一次工具调用追加条目（`index.ts:903-906` 在 `:910` 的 `if (decision.outcome === 'allow') return` 之前）。把它整体当「命令活动」的话，纯分析任务会永远显得「有活动」——这正是 E6 必须按 `commandClass` 过滤的原因。

## 落盘

**复用** `state-persister.ts` 现有的原子 tmp+rename（`:177-184`）+ per-runId Promise 链锁（`:170`）。不新造持久化机制。

⚠️ **落盘根须与 E1 统一后的根一致**，否则台账会原样重演 P0-2。这是 E1 阻塞本 ticket 的原因。

## 其余要点

- **容量控制**：保留最近 N 轮明细，更早的**折叠为摘要并替换**——不能叠加旧摘要（对齐 Ghost Context）；
- **结构化 JSON 而非 Markdown**（借 Anthropic feature-list 形态：模型更不敢乱改），区分「已完成 / 进行中 / 未开始」三态；
- **消费点两处**：`agent_turn_prepare` 的注入（`index.ts:758-783`）与 `buildRetryInstruction`（`continuation-engine.ts:106-139`）都改吃台账摘要；
- **对齐 Governance Decay**：`after_compaction`（`index.ts:708-716`）除恢复 goal 外须**重新注入**约束与台账摘要，不假设 in-context 约束存活；
- 顺带修 P1-11 的 `progress` 恢复优先级不对称（`autopilot-state.ts:125-133`，goal 取当前、progress 取快照）——台账落盘后 `progressSnapshot` 的存在意义本身该重估；
- **对 P1-13**：台账能记录 subagent 扇出期间的工具活动（`after_tool_call` 的 sessionKey 是子会话，需经 `findRunBySessionOrParent` 归并）。这是本方案**唯一**需要动 half-merge 边界的地方，**且只动观测不动权限**，不违反既有决策。

## 验收

- [ ] 台账落盘根与 E1 一致
- [ ] `filesTouched` 来自 `after_tool_call`，非 `permissionAudit`
- [ ] `commandsRun` 只含执行类，不含只读调用
- [ ] 容量折叠是替换而非叠加
- [ ] 压缩后注入的是台账摘要而非计数串
- [ ] subagent 活动能归并到父 run（仅观测）
- [ ] E6 的 no-progress 判定能消费本台账
