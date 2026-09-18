# 长程任务自主执行 GAP 矩阵

**基准日期**：2026-09-18  
**证据来源**：5 份调研报告（OMM 内部、MA host 侧、openclaw、forced-completion、Kimi/OpenHands/aider/Anthropic/arXiv 子调研）

---

## ⚠️ 与现有 ticket 体系的对账（2026-09-18 补）

**本矩阵初版独立于现有 ticket 池生成，约三分之一的行在重复已落地或已建票的工作。** 先读这一节再读下表。

现行票池（两处，都在用 local-markdown 约定）：

- `oh-my-matrix/.scratch/README.md` + `issues/` —— E1–E13 系列，**已基本完工**。README 明写「OMM frontier 剩余 = 0 张可立即开」
- `oh-my-matrix/.scratch/next-round/issues/` —— 10 张，ticket 02/03/04 已落地（见 commit `bdf4815`/`22c9e23`）
- `oh-my-matrix/.scratch/autopilot-enhancement/issues/` —— 13 张，「loopx enhancement line」，ticket 02/06/08/11/12 已落地（commit `b92be99`）
- `MatrixAssistant/.scratch/autopilot-long-horizon/` —— **历史文档**，最后更新 2026-08-10，其「剩余 12 张」已过期

### 逐行对账

| 本矩阵的 GAP | 真实状态 | 归属 |
|---|---|---|
| MA run 台账不落盘 / `resumeRestoredRuns` 空集合 | **已有票**，`Status: ready-for-agent`，`Blocked by: 05` | `next-round/issues/08-ma-resume-run-consumption.md` |
| `maxCostUsd` / `maxDurationMs` | **引擎侧已落地**（PR #136/#137）。本矩阵的增量仅剩「默认未配」 | E2 ✅ |
| `no_progress` 停滞检测 | **引擎侧已落地**（PR #143，在飞守卫 + 生产力检测）。增量是 openclaw 的「计费 ≠ 进展」判据更严 | E6 ✅ |
| `skipped` 按成因分叉 | **引擎侧已落地**（PR #145，step1-2） | E4 🟡 step3 卡 M2 跨仓 |
| 中途 gate | **已落地**（PR #144，每 5 轮） | E7 ✅ |
| 错误分类 | **引擎侧已落地**（PR #136/#137）。MA 侧子串匹配仍在 | E3 ✅ |
| MA host 零完成判据 | **真新，无票** | — |
| MA ↔ openclaw seam 重试无人负责 | **真新，无票** | — |
| verifier 前的零成本预筛 | **真新，无票**。⚠️ 勿与 `next-round/02-hook-deterministic-prescreen.md` 混淆 —— 那张是 dynamic-workflow 的 fan-out 触发，不是完成预筛 | — |
| handoff 产物缺失 | **真新，无票** | — |
| completion audit 四条硬规则 | 部分可能对应 `autopilot-enhancement/06-goal-acceptance-field.md`，**待核** | 待定 |
| OMM ① `hasMigrationGrace` 断开的 seam | **真新，无票**（F3 声称修复但未生效） | — |
| OMM ② patrol stale-snapshot | **真新，无票** | — |
| OMM ③ `RESUMABLE_BLOCKED_LOCAL` 镜像 | **真新，无票** | — |

### 对账的两条结论

1. **引擎侧（OMM `packages/autopilot/`）在六维度上的机制大体齐了** —— E 系列 13 张里 12 张已合入，autopilot 从 3.1.0 走到 4.4.1。本矩阵最初把 E2/E3/E4/E6/E7 的成果当成「缺口」，是因为独立盘点没先读票池。这些行现在降级为「已落地，仅默认值/配置待定」。
2. **真正的空白集中在两处**：**MA host 侧的消费与判定**（P0-2、P0-3、seam 契约），以及**本矩阵新发现的三个 OMM 结构缺陷**（都是 deletion test = 收敛，且都不撞 ADR）。这两类是本轮调研的净增量。

### 独立撞票是验证信号

`next-round/08` 与本矩阵的 P0-1 各自独立写出同一个缺口，这提高了该缺口为真的置信度。但也说明：**下次开新一轮调研前先读 `.scratch/`**。

---

## 如何读这张表

每行是一个「业界有、我们没有」的 GAP，或「我们有但默认未开」的配置空白。  
**类型**列区分两类：

- **结构缺口**：跟模型版本无关，代码层面就没有。修了就有，不修就一直没。  
- **模型补丁**：针对特定模型行为的 harness 补偿。模型换代后可能变成死重（Anthropic 的 `context anxiety` reset 就是案例）。

**优先级**：P0 = 跨越 seam 的悬空契约 / 当前直接失效；P1 = 有机制但配置空白；P2 = 值得建但不紧急。

---

## 6 维度 GAP 表

### 维度 1：任务状态持久化

| GAP | 现状（我们） | 业界标准 | 类型 | 优先级 | 出处 |
|---|---|---|---|---|---|
| **MA host 侧 run 台账纯内存，进程重启丢失** | `autopilot-cross-turn-driver.ts:130` 的 `Map<sessionKey,{...}>` + 30min TTL，**不落盘**，重启后 `resumeRestoredRuns` 遍历空集合什么都不做（`:175-182`） | kimi-code：每 session 独立目录 + append-only `wire.jsonl`（事件溯源）；openclaw：单一 SQLite `task_runs` 表；aider：`auto_commit` 每步提交 | 结构缺口 | P0 | MA host 盘点 §缺口一；openclaw `openclaw-state-schema.sql` |
| **OMM 侧 `RESUMABLE_BLOCKED_LOCAL` 镜像已失效** | `state-persister.ts:652-665` 手抄 `orchestrator.ts:28` 的集合，理由是「避免循环 import」，但 `:32` 已经在 import orchestrator，无环。E6 漏同步过一次，PR #147 补救 | 单一 canonical 集合，单向依赖无需镜像 | 结构缺口 | P1 | OMM 内部盘点 §缺口三 |

---

### 维度 2：中断恢复

| GAP | 现状（我们） | 业界标准 | 类型 | 优先级 | 出处 |
|---|---|---|---|---|---|
| **跨 repo 悬空契约：OMM 把 crash-recovery 交给 host，MA 没人接** | OMM 代码注释自认「stall 回落是 FALLBACK，不是无害 no-op」；MA 的 `resumeRestoredRuns`（`driver:175-182`）重启后遍历空 Map | openclaw 的 `on-exit` watcher：持久化**先于**触发，armToken 在 await 前同步预留 slot，未知结局不触发（`cron-exit-watchers.ts:109-182`） | 结构缺口 | P0 | OMM 盘点 §恢复；MA 盘点 §缺口一；openclaw §缺口② |
| **OMM `.omc/handoffs/` 磁盘上不存在** | compaction 后无结构化 handoff 产物 | kimi-code：compaction 产出 handoff summary + `wire.jsonl` 行号窗口的 Context Recovery 指针，告诉模型去哪捞原始数据（`fullCompaction/context-recovery-footer.md`）；Anthropic blog：`claude-progress.txt` + git history 让新 context agent 快速理解状态 | 结构缺口 | P1 | kimi-code 维度 2.2；Anthropic [5-1]/[5-2] |
| **kimi-code 的日志修复机制我们没有** | 无 | `wire/repair.ts:20-46`：日志写坏时备份原文件 + 截断到最后有效前缀 + 重写 + telemetry | 结构缺口 | P2 | kimi-code 维度 2.3 |

---

### 维度 3：完成判定

| GAP | 现状（我们） | 业界标准 | 类型 | 优先级 | 出处 |
|---|---|---|---|---|---|
| **MA host 侧零完成判据，两侧判据冲突** | host 收到 `status: 'done'` 就渲染 Done；grep `evidenceGate\|acceptanceGate\|completionDetect` → 0 命中 | 权威文档 §7.2 明文「`skipped` is not success」；§7.3 要求 MA supervisor 做 final acceptance | 结构缺口 | P0 | MA 盘点 §缺口二；OMM `design.md:471-474` |
| **verifier 之前缺零成本预筛层** | verifier agent 是唯一关卡，每次都跑一次 agent 调用 | openclaw `task-completion-contract.ts:11-83`：95 行纯函数三层正则，命中即 `blocked`，4 个 runtime 复用；OpenHands `AgentFinishedCritic`：空 patch → score=0（无需 LLM） | 结构缺口 | P1 | openclaw §机制①；OpenHands §2 |
| **kimi-code 的四条 completion audit 硬规则未落地** | 无对应 prompt 约束 | 「弱证据不算完成」「只出计划/摘要/first pass 不算完成」「预算快耗尽不是完成的理由」「报 blocked 需同一条件连续 3 个 goal turn」（`goalService.ts:139-160`） | 模型补丁 | P1 | kimi-code 维度 3.2；**但前三条是结构性约定，建议写进 AGENTS.md** |
| **AC-NNN `Verification` 字段只进 prompt，不接 gate** | 验证要求只是提示，不是硬阻断 | OMM 设计稿有定义，运行时不强制 | 结构缺口 | P1 | OMM 盘点 §完成判定例外 |

---

### 维度 4：循环终止

| GAP | 现状（我们） | 业界标准 | 类型 | 优先级 | 出处 |
|---|---|---|---|---|---|
| **`maxCostUsd` / `maxDurationMs` 已落地但默认未配** | 机制在代码里，默认值未设，等于没有 | 四家独立收敛：预算耗尽 = blocked/error，不是 complete（Kimi `goalService.ts:114-129`；OpenHands `MaxBudgetReached`；SWE-agent 93% 成功案例没撑到预算耗尽；kimi-code 「Do not mark complete merely because a budget is nearly exhausted」） | 配置空白 | P1 | OMM 盘点 §循环终止；四路子调研交叉 |
| **`no_progress` pause 没有「先 nudge」机制** | 停滞检测直接 pause，无警告层 | OpenHands `StuckDetector`：streak 刚撞阈值时先发一次警告（「重复了 N 次得到同样错误，继续重复不会有用，试试别的思路」），不停；nudge 后仍不改才标 STUCK | 结构缺口 | P2 | OpenHands §5 |
| **openclaw 的 idle-timeout 判进展方式我们可借鉴** | `no_progress` 按轮次计，可能被「有输出」打穿 | `idle-timeout-breaker.ts:10-16,54-60`：只有 durable text/tool-call progress 才复位计数器，provider 计费了 partial output token **不**复位。事故记录（issue #76293）：heartbeat 触发 761–1384 次付费调用/60 秒，$20-30 每次 | 结构缺口 | P1 | openclaw §机制③ |

---

### 维度 5：context 管理

| GAP | 现状（我们） | 业界标准 | 类型 | 优先级 | 出处 |
|---|---|---|---|---|---|
| **handoff 产物不存在（`.omc/handoffs/` 磁盘上没有）** | 见维度 2 | 见维度 2 | 结构缺口 | P1 | OMM 盘点 §context |
| **compaction 指令缺「先前声称完成但未验证的步骤必须标 unverified」** | 无 | kimi-code `compaction-instruction.md:59-62`：「if an earlier step claimed something was done but was never verified, say so plainly and treat it as unverified rather than fact — re-check before relying on it」 | 模型补丁 | P2 | kimi-code 维度 2.2 |
| **TODO 列表不进 compaction 摘要、从 live source 重挂** | 不详 | kimi-code `compaction-instruction.md:53-57`：「Your TODO list is re-attached automatically below this summary from its live source, so do not transcribe it — copying it wastes space and can contradict the live version」 | 结构缺口 | P2 | kimi-code 维度 5.3 |

---

### 维度 6：委派

| GAP | 现状（我们） | 业界标准 | 类型 | 优先级 | 出处 |
|---|---|---|---|---|---|
| **MA ↔ openclaw seam 上重试无人负责** | `runModifyingHook`（`hooks.ts:647-692`）单趟执行，catch 只记日志，零重试循环。MA 5 个扩展无一实现重试 | openclaw 核心提供 `withHookTimeout` + 三级优先级（运维 > 插件），但 `before_tool_call`/`after_tool_call` 不在默认超时表，且超时**不取消**插件底层工作（`:202-204`）；`before_tool_call` 是 fail-closed（抛错 → 工具调用被阻断） | 结构缺口 | P0 | openclaw §MA seam；MA 盘点 §缺口三 |
| **MA ↔ openclaw 挂载 interface 三套并存** | 2 个走类型化 SDK、1 个手写 interface、2 个裸导出 `any` | 统一契约，`HostPluginApi` 不应靠 `extends Record<string, unknown>` 穿透不检查；`config` 的 no-op stub 静默丢弃配置读取 | 结构缺口 | P1 | openclaw §MA seam；MA 盘点 §缺口三 |
| **自审失效有量化证据，OMC 的 author/reviewer 分离是否到位？** | CLAUDE.md 规定不在同一 active context 自审，走 `code-reviewer`/`verifier` | Self-Refine 论文：同一 LLM 三角色时 94% 反馈是「看起来都挺好」；Anthropic blog：「tuning a standalone evaluator to be skeptical turns out to be far more tractable than making a generator critical of its own work」—— **分离只是前提，evaluator 必须专门调成 skeptical** | 模型补丁 | P1 | Self-Refine §3；Anthropic [3-3] |
| **subclient 委派深度未强制** | 未在 ADR 里找到 subagent 不能再派 subagent 的强制机制 | kimi-code：三个内置 subagent 不能再派 subagent，双重白名单校验；`goal`/`cron`/`tower` 工具 main-agent-only；`tower` 只有用户能开，agent 不能自己开 | 结构缺口 | P2 | kimi-code 维度 6.2 |

---

## 横切关注点

### 「模型补丁 vs 结构缺口」说明

Anthropic 博客 `managed-agents` 记录：为 Sonnet 4.5 加的 context reset 在 Opus 4.5 上变成了死重。这条教训适用于上表的所有「模型补丁」行——建这些机制时要带失效条件，换代模型后重新评估。

「弱证据不算完成」「预算快耗尽不是完成理由」这两条虽然以 prompt 形式实现，但它们是**结构性约定**，建议写进 `AGENTS.md` 而不是只留在 prompt 里——这样换模型后它们还在。

### 四路收敛信号：预算耗尽 ≠ 完成

Kimi / OpenHands / SWE-agent / aider 四个独立实现全部得出同一结论。这不是某一家的偏好。OMM 的 `maxCostUsd`/`maxDurationMs` 默认未配，是当前最容易修的配置空白。

### 「先持久化再推进」不变量

openclaw `cron-exit-watchers.ts:109-182` 把这条写成三不变量之一。OMM `.omc/state/` 是 JSON 持久化，autopilot iteration 推进是否遵守「先持久化再推进」需要核查——违反的话崩溃重启会重跑已完成 iteration。

### 已知的双份文档问题

MA 仓有两份「权威」文档并存：`docs/core/long-horizon-autonomy.md`（v2.1，non-goal #7 禁止再建）和 `docs/core/autopilot/long-horizon-autonomy.md`（v2.2，更新，含三条翻盘）。v2.1 的 non-goal #7 被 v2.2 自身违反。实施以谁为准无定论——这是 `/wayfinder` 的 decision ticket，不是代码 bug。

---

## 优先级汇总

| 优先级 | GAP 数 | 代表条目 |
|---|---|---|
| P0 | 3 | MA run 台账不落盘；跨 repo crash-recovery 悬空契约；MA host 零完成判据 + MA ↔ openclaw seam 重试无人负责 |
| P1 | 8 | `maxCostUsd`/`maxDurationMs` 默认未配；零成本预筛层缺失；completion audit 规则未落地；idle-timeout 判进展方式；handoff 产物缺失；挂载 interface 三套；自审 evaluator skeptical 调优；AC-NNN Verification 不接 gate |
| P2 | 5 | nudge 机制；日志修复；compaction unverified 声明；TODO live source 重挂；委派深度未强制 |

---

*本文件由 2026-09-18 session 综合生成，待 `harness-mechanisms`（Codex/ClaudeCode/ZCode 部分）落盘后可能补充更新。*
