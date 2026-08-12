# 12 — Evidence-coupled 记账回归修复（02 /code-review 发现）

**What to build:** 修复 02（feacd81）实施后 /code-review 发现的 3 个 CONFIRMED 回归 + 配套语义收紧 + 测试。02 未合 master，现在修最便宜。

**Blocked by:** 02（已实施）

**Status:** 部分完成 — F6 已修（本 worktree）；F1/F2/F7/F8 需 host runtime（host-runtime-blocked）

## Worktree 边界（2026-08-12 接手确认）

本 worktree = `@oh-my-matrix/autopilot` npm package 源（reducer/projection/ledger 纯函数）。**不含** `index.ts` / `agent_end` handler / `setAuditMode` / `patrol` tick——那些在 host 消费侧（gateway `index.ts`，ADR-010 的 host-deploy 目标）。因此：

| Finding | 修复点 | 本 worktree 可修? |
|---|---|---|
| **F1** stale evidence stamping | host `index.ts` agent_end（:1309） | ❌ host-runtime |
| **F2** audit refcount over-release | host `index.ts` no_progress pause（:1962） | ❌ host-runtime |
| **F3** legacy `?? 0` | `progress-ledger.ts:171`（本 worktree）但根因是 checkpoint schema，并入 08 | ⚠️ 随 08 |
| **F6** skipped/not_executed 语义 | `progress-ledger.ts`（本 worktree） | ✅ **已修** |
| **F7** off-by-one gap 算术 | gap 计算在 host patrol；`lastProgressTurn` 基准在本 worktree | ⚠️ 部分（基准已对齐 F6，算术待 host） |
| **F8** wiring 测试（agent_end stamp → patrol） | 需 host runtime harness | ❌ host-runtime |

F1/F2/F8 的非手建 wiring 测试在本 worktree **无法写**——本 package 不持有 agent_end/patrol 路径。这三项 + F7 的算术部分留给 host 仓库（见 ADR-010 host-deploy step）。

## CONFIRMED 回归（必修）

### F1 🔴 stale `'failed'` stamping 砖掉修复中的 run
- **机制**：evidence gate 只在 complete 路径跑（`index.ts:885`），`state.evidence` 是**最后一次 gate 结果**，只有 `activate_requested` 清（`orchestrator.ts:98`）。修复轮（gate 失败后写文件继续干，走 revise 路径）→ `agent_end`（`index.ts:1309`）用 stale `state.evidence?.status` stamp 本轮 entry 为 `'failed'`
- **后果**：`lastProgressTurn` 卡在 gate 失败轮 → patrol（`index.ts:1959`）判 gap ≥ threshold → `pause_requested('no_progress')` **误暂停修好中的 run** → resume → 下一轮又 stamp `'failed'` → 再暂停 → **一 turn 一 resume 的死循环**。旧代码（last entry turn）从不在此 pause。02 "不误报" AC 被违反
- **修法**：agent_end stamp 改为——只在本轮真跑过 gate（complete 路径）时用 `state.evidence?.status`；revise 轮 stamp `undefined`（mid-run turn，count as progress）。或追踪 per-turn gate 结果

### F2 🔴 audit refcount over-release
- **机制**：no_progress pause 无条件 `setAuditMode('active')`（`index.ts:1962`），但 `pause_requested` 对 `retry_queued` 是 no-op（`orchestrator.ts:370` `if (!runningFamily.includes(...)) return state`），而 `deriveStatus(retry_queued)==='running'`（patrol guard `index.ts:1955` 通过）
- **后果**：retry→fail→retry_queued 循环中，每个 60s tick 释放 audit monitor refcount；之后真 pause（hard cap/stall/agent_end）再释放 → **双重释放共享 refcount** → 摘掉其他并发 run 的 audit monitor。其他 pause 点都 guard reducer 结果（`index.ts:1337-1338` "a no-op must not release"），这个没有
- **修法**：guard 在 reducer 结果（同其他 pause 点）——reducer no-op 则不释放

### F3 🔴 legacy checkpoint `?? 0` → 升级后第一 tick 误暂停（并入 ticket 08）
- **机制**：旧 checkpoint 的 folded 无 `lastValidatedTurn` → `?? 0`（`progress-ledger.ts:171`）
- **后果**：升级后 resume → 全 failed detail 窗口 + 旧折叠 → `lastProgressTurn=0` → gap=10 ≥ 3 → **零新轮就 pause**。无 checkpoint versioning guard
- **修法**：并入 ticket 08（checkpoint schemaVersion + 恢复时 migration/normalize 补 `lastValidatedTurn`）

## 语义收紧（建议同批）

### F6 `'skipped'`/`'not_executed'` 算 progress — ✅ 已修（本 worktree，2026-08-12）
- **机制**：`progress-ledger.ts:167` `evidenceStatus !== 'failed'` 让 `'skipped'`（含 fail-closed 的 `'not_executed'`——allowlist 丢弃的 required 命令，`index.ts:840`）算 progress
- **后果**：validator 从未真跑的 run 读成"在推进"——与 gate fail-closed（blocked evidence_missing）矛盾
- **修法（实施）**：抽 `countsAsProgress(status, skipReason)` helper，`lastProgressTurn` + `foldOldest` 共用（F12 重复谓词消除）。`LedgerEntry`/`buildEntry` 透传 `skipReason`。
- **⚠️ 语义决策（surface per AGENTS.md）**：ticket 原文说"只有 `passed`/`undefined` 算"——**未采纳此一刀切**。按 `evidence-gate.ts:30-51` 的实际语义区分：`'skipped'+'not_configured'`（项目没配验证）**仍算 progress**，否则绝大多数无验证配置的项目会永远 no_progress 误暂停；只有 `'skipped'+'not_executed'`（配了被丢弃/errored）不算。即 fail-closed 边界对齐 gate 自身的 `skipReason` 判断，而非 status 字符串。测试覆盖两种 skipReason 分支。

### F7 off-by-one
- **机制**：gap 算术计 in-flight 轮（`totalContinuations` 在 `before_agent_finalize` revise 时增，`index.ts:748`，早于本轮 entry stamp）+ turn-0 sentinel 碰撞
- **后果**：有效阈值 = threshold-1，pause 在第 N 轮**开始**时触发（可能 mid-production）
- **修法**：gap 用 stamp 后的 turn 基准；turn-0 sentinel 单独处理

## 测试（F8 gap 修复）

- [ ] **F8**：契约测试——gate 失败于 N、productive 轮 N+1..N+3 stamp 后，no_progress **不** fire（F1 回归防护）
- [ ] **F8**：wiring 测试——构造生产 stamping 路径（agent_end stamp → patrol），非手建 ledger
- [ ] F2：retry_queued no-op pause 不释放 refcount
- [ ] F6：`'not_executed'` 不算 progress
- [ ] F7：threshold 边界精确

## 验收
- [ ] F1：修复 run（gate 失败后 productive revise 轮）不被 no_progress 暂停 — **host-runtime-blocked**
- [ ] F2：retry_queued no-op 不释放 audit refcount — **host-runtime-blocked**
- [x] F6：validator 未跑的 run（`skipped`+`not_executed`）不算 progress（本 worktree 已修，8 测试覆盖）
- [ ] F7：threshold 边界精确 — 部分（基准已对齐 F6，gap 算术待 host patrol）
- [ ] F8：stale-stamping 回归有 wiring 测试守护 — **host-runtime-blocked**（本 worktree 无 agent_end/patrol）
- [x] 全量测试绿 + typecheck（本 worktree：1008 passed / 4 skipped，tsc 干净）
