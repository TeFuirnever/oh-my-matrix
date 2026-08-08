# E6 — 生产力型停滞检测 + 在飞守卫

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P0-6（stall 双向失效）+ P1-14（validation 期 TOCTOU）
**被阻塞**: **T0**、**E5**（方向二消费台账）
**阻塞**: E7（中途 gate 会拉长在飞时间）
**设计文档**: §5.6

> ⚠️ **本 ticket 不阻塞 M1**。v1 曾结论「5.6 必须先于 5.10」，该结论建立在双驱动前提上，M1 改为主进程单驱动后**已论证解除**（设计文档 §7「实施顺序」）。

---

## 两个方向都要修

P0-6 是**双向失效**：既误报长工具，又漏报快速空转。

### 方向一：修误报（在飞守卫）

- `tool_call` 派发后**抑制** stall 计时，直至 `tool_result` 到达或单工具上限（建议 30min）——区分「静默」与「等待中」；
- 实施：`before_tool_call`（`index.ts:850`）与 `after_tool_call`（`:669`）已成对存在，只需在 state 加 `inFlightToolStartedAt?: number`，巡检见其非空则改用单工具上限而非 `stallTimeoutMs`；
- **同时覆盖 P1-14**：`await runValidationCommands` 期间同样置该字段（evidence 也是「在飞的长操作」），消除 validation 期误报与 TOCTOU 覆写。

⚠️ **必须处理字段悬挂**：`after_tool_call` 未到达就崩溃/turn 结束时，字段残留会**永久禁用 stall 检测**。`agent_end` 与 `before_agent_finalize` 都要清零。这条漏了会把一个检测缺陷换成更严重的检测失效。

### 方向二：修漏报（生产力检测）

- **保留**纯静默检测（`checkStall` 不动），**新增**「有活动但无产出」判定；
- 判定对齐 Dead Step 定义：连续 N 轮（建议 3）台账中零 `filesTouched` 且零新 `commandsRun` → `pause('no_progress')`；
- 借 fail-open 原则：**台账读不出时不判 no_progress**，避免误杀；
- 正面回答 `tool-error-tracker.ts:14-17` 自承的盲区，顺带覆盖 `A→B→A→B` 交替失败；
- 阈值沿用 `workflow-config.ts` 的「YAML 前言可配 + 默认常量」风格。

## ⚠️ 「零新 commandsRun」的语义必须先锁定再实现

这是设计文档标记的**对抗 review 阻断项**。

判定输入**只能**是按 `commandClass` 过滤后的执行类活动（`validation` / `destructive_git` / 未分类 exec），**不能**是 `permissionAudit` 全量——后者含只读调用（它在 allow 判定前就为每次调用追加条目，`index.ts:903-906`），会让该检测在分析任务上**永不触发**。

**过滤规则先锁定，再写检测。** 顺序反了就是白写。

## ⚠️ 已知误报风险与取舍

纯分析型任务（只读代码、只输出结论）天然零文件变更、零执行类命令——**会命中**本判定。

缓解：
- `no_progress` 归入 resumable（配合 E4 第三步，此时 resumable 才真正有意义）；
- N 不宜小于 3；
- 必要时允许算子按任务类型关闭。

这是「误停一个分析任务」与「放任一个死循环烧 30 轮」之间的取舍，**选择前者**。这是产品决策，不是实现细节——实施时别自行改成后者。

## 验收

- [ ] 长工具（超 `stallTimeoutMs`）**不**被判 stall
- [ ] `inFlightToolStartedAt` 在 turn 结束/崩溃后被清零（专项测试）
- [ ] validation 期不再误报，无 TOCTOU
- [ ] 快速空转循环能被 no_progress 检出
- [ ] **纯分析型任务（只读、无写）不被误判**——这是必测项
- [ ] 台账读不出时 fail-open，不判 no_progress
- [ ] `commandClass` 过滤规则有明确文档与测试
