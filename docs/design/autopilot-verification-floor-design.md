# Autopilot 验收基线 + 进展结构化（落地设计）

> **Status**: ✅ 必做部分已实施核验（2026-08-09）—— 本设计为事后文档化；§5.4/§5.5/§5.6 已落地于代码（见 §8 核验表），剩选做 T05/T06 待办
> **裁决性质**：本设计是 5-agent 对抗 review 后的**落地决策**——确认两块缺口 = `long-horizon-autonomy.md` 既有的 §5.4（验收）+ §5.5（进展）ticket，**排除所有外部引入方案**（Task Flow / planning-with-files / cwc evaluator / spec-kit），直接实施既有自建设计的**最小子集**。
> **关联**：`docs/core/autopilot/long-horizon-autonomy.md` §5.4/§5.5/§5.6/§5.12 · `docs/adr/019-conditional-evidence-judging-boundary.md` · `docs/audits/openclaw-native-vs-autopilot-2026-08-05.md`（E4+E7/E5）· 研究报告 `.claude/plans/users-guanxueliang-desktop-matrix-dynam-happy-sundae.md` Part H

---

## 1. 背景与裁决

用户问：oh-my-matrix 是否缺「任务拆解/规划」与「验收/verify」两块能力，能否引入 ralplan / planning-with-files / openclaw 原生 / zcode `/goal`。

**研究结论**（详见 plan 文件 Part A–H）：两块缺口真实存在，但**程度不对称**，且**早有既有 ticket 与设计**：

| 缺口 | 真实程度 | 既有 ticket | 既有设计 |
|---|---|---|---|
| 验收/verify | **部分缺失**（evidence-gate 机器在，但 `skipped`≡`passed`→done，默认零验证） | E4+E7（P0-4） | §5.4 三步 |
| 规划/进展 | **部分缺失**（`progress` 仅计数串，但已注入续轮+已过 compaction 快照） | E5（P1-11） | §5.5 progress-ledger |

**5-agent 对抗 review 共识**（plan Part H）：
1. 外部蓝本研究扎实，但**全部落地方案 FLAWED**：
   - **Task Flow 做 checkpoint**：路径错（`api.runtime.tasks.flows` 复数=只读 DTO；写入在 `.flow` 单数 / `managedFlows` @deprecated）；**解决已解决问题**（`state-persister.ts` 原子 JSON + register 恢复已有，root bug commit `e23b2a6` 已修）；范畴错（状态机≠planner）；版本 churn（`managedFlows` @deprecated 无 EOL）。
   - **planning-with-files 做 ledger**："4 行 hook 映射"假（4 个里 2 个无注入通道；openclaw hook 是返回结构化对象的 TS 函数、非 stdout 管道 sh）；与 §5.5 冲突；`findings.md` 二阶注入面；回退链断。
   - **cwc fresh-context evaluator**：**ADR-019（2026-07-08 Accepted）已显式 deferred + 退出条件**；capability 级不可行（`SubagentRunParams` 无 `allowedTools` 字段，cwc 安全性来自 capability 级，openclaw 只有 `extraSystemPrompt` prompt 级）；cost/benefit 倒挂。
   - **progress-only-text 检测器**：冗余（`isTaskComplete` 只触发显式完成短语带否定守卫，"I'll verify…" 不匹配→落 `revise`；autopilot 无此失败模式）。
   - **cwc verify-gate**：cwc 是 unconference demo（3 commits、"不维护"、`verify-gate.sh` 自称"教学示例非安全边界"+3 绕过路径）——参考价值有，非可移植产品。
2. **host `goal_manager` 是 ADR-007/008 文档吹嘘**（`@openclaw/autopilot` 是 symlink 指向本仓自身，不存在；`goal-manager.ts` 仅 17 行单 goal string）——"别与 host 重复"moot。

**裁决**：不引任何外部方案。**直接实施 §5.4 + §5.5 最小子集**。这是 ponytail 最短路径：既有设计 + 对抗 review 背书，零新依赖、零新框架、零新 hook。

> ⚠️ 纠正 review 的过度简化：验收修复**不是**"orchestrator.ts:261 只认 passed"一行——§5.4 已精细设计为**区分 `skipped` 两因**（见 §3）。本设计忠实于 §5.4，不照抄 review 的简写。

---

## 2. 范围与非目标

**范围内**：
- §5.4「`skipped ≠ passed` + resume 守门」（验收基线）
- §5.5 进展台账的**最小前置子集**（先把 `progress` 字段填实，不建独立 ledger 文件）
- 落地前置：§5.6 在飞守卫（防 TOCTOU 反噬）

**非目标**（理由见 §1 + plan Part H）：
- ❌ 引入 openclaw Task Flow 做 checkpoint 根
- ❌ 引入 planning-with-files 做 plan 台账
- ❌ cwc fresh-context evaluator / 任何独立 LLM 评审员（ADR-019 延迟项，另开 ADR-022）
- ❌ progress-only-text 正则检测器
- ❌ autopilot 加"规划/拆解阶段"（§1 非目标 + `effort-injection.ts:43-44` "NO planning phase" + ADR-019 已决定）

---

## 3. 验收基线 —— 实施 §5.4（三步）

§5.4 已是 APPROVED 设计。本节是其**落地编排 + review 补充约束**，不重复其论证。

### 3.1 第一步：区分 `skipped` 两种成因（`orchestrator.ts:261`）

当前 `evidence_finished` 分支（`orchestrator.ts:261`）：`passed || skipped → done`。改为区分两因：

| `skipped` 成因 | 处置 | 理由 |
|---|---|---|
| **从未配置**验证命令（`commands.length === 0`） | `done` + `completionUnverified: true` | 无测试项目是合法场景，不该被拦 |
| **配置了但没跑成**（命令缺失/超时/被 allowlist 丢弃，`commands.length > 0` 却无有效结果） | `blocked` + `blockedReason: 'evidence_missing'` + `completionUnverified: false` | "本应验证却没验证"才是真风险；blocked 非 completion，信号由 `blockedReason` 承担（四轮 review 修正：避免 blocked 被消费方误读为"已完成但未验证"） |

**实施要点**（§5.4 line 1261-1262）：
- `evaluateEvidence`（`evidence-gate.ts:23-95`）新增**显式字段** `skipReason: 'not_configured' | 'not_executed'`，**不要靠匹配 `failureReason` 字符串**区分。
  - `commands.length === 0` → `skipReason: 'not_configured'`（保持现有 `failureReason: 'no validation commands configured'` 供人读）。
  - `commands.length > 0` 但无有效结果 → `skipReason: 'not_executed'`。
- ⚠️ `index.ts:619` 的 **fail-open 分支**也产出 `skipped` + `failureReason: 'evaluation error'`——它属"配置了但没跑成"，必须归入 **blocked（`evidence_missing`）** 一侧，不能漏到 done。
- `orchestrator.ts:261` 改为：`passed → done`；`skipped + skipReason==='not_configured' → done + completionUnverified`；`skipped + skipReason==='not_executed' → blocked + evidence_missing`；`failed → 现有 retry 路径`（不变）。
- `EvidenceSummary`（`types.ts`）新增 `skipReason?` 与 `completionUnverified?` 字段。

### 3.2 第二步：让 `evidence_missing` 真正可达

上表"not_executed"行是 `blockedReason: 'evidence_missing'` 的**首个生产写点**。
- ✅ `VALID_BLOCKED_REASONS`（`types.ts:50`）已含 `'evidence_missing'`（line 55）——无需改。
- ✅ 恢复 allowlist（`state-persister.ts:432` `RESUMABLE_BLOCKED_REASONS`）已含——无需改。`evidence_missing` 是 **resumable**（用户配置验证后可一键 resume）。
- 实施后验证：构造 `commands>0 + 全 skipped/缺失` 场景 → 落 `blocked/evidence_missing` → resume 可达。

### 3.3 第三步：让 resume 尊重守门（行为破坏性变更）

§5.4 line 1268-1289。`autopilot.resume`（`index.ts:1318-1335`）在 reducer no-op 时**必须停**，不再继续调 setter：

```ts
const orchestrated = orchestratorReducer(state, { type: 'resume_requested', runId, now });
if (orchestrated === state) {                       // reducer 拒绝了（不可恢复）
  respond(false, undefined, { code: 'INVALID_REQUEST',
    message: `cannot resume: ${state.blockedReason} is not recoverable` });
  return;
}
```

- `resume()` setter 职责收缩为**清副状态**（`toolErrorCount`/`lastToolError`/`degraded`/`retry`），**不再自行写 `orchestrationState`/`blockedReason`**（reducer 职责，ADR-016）。
- `projection.ts` 透出 `completionUnverified` 与 `canResume`（`RESUMABLE_BLOCKED_REASONS.has(blockedReason)` 计算）。
- ⚠️ **破坏性**：当前用户能 resume 任何 blocked run；修正后只有可恢复的能 resume。**必须与 §5.12「必做 1」同批**（按钮显示条件从 `isPaused` 改为 `canResume`），否则 `deriveStatus` 把不可恢复 blocked 也派生成 `paused`，用户得到永远点不动的按钮。CHANGELOG 标 minor 并写明。

### 3.4 测试影响（§5.4 line 1285-1289，已实测）

**不会被打断**（行为保持）：以下断言"无命令→skipped→done"，本设计保持该行为（仅加 `completionUnverified`），需同步预期：
- `tests/evidence-wiring.test.ts:86-93`（`evidenceStatus==='skipped'`）、`:96-103`（`projection.status==='done'`）
- `tests/orchestrator.test.ts:594-603`（`evidence_finished(skipped)` → `status='done'`）
- `tests/e2e/lifecycle.e2e.test.ts:150`（no commands ⇒ skipped ⇒ done）

**会被打断**（第三步）：任何断言"非可恢复 blocked 也能 resume"的测试——实施时 grep `autopilot.resume` 测试覆盖并更新。

**新增 contract 测**：
- `commands>0 + 全 not_executed` → `blocked/evidence_missing` + `canResume===true`
- `commands===0` → `done` + `completionUnverified===true`
- `passed` → `done`（不变）
- fail-open 分支（`index.ts:619`）→ `blocked/evidence_missing`（不漏到 done）

---

## 4. 进展结构化 —— §5.5 最小前置子集

§5.5 完整设计是独立 `progress-ledger.ts`（LedgerEntry: turn/filesTouched/commandsRun/evidenceStatus/openItems）。**本设计只做其最小前置**：先把现有 `progress` 字段填实，不建新文件。

### 4.1 缺陷

`index.ts:1128` 是 `progress` 唯一写入点：
```ts
progress: `Turn ${afterOrchestrator.totalContinuations}/${afterOrchestrator.maxTotalContinuations} completed`,
```
计数串。但 `progress` 已被注入续轮（`continuation-engine.ts:108-114`）+ 已过 compaction 快照（`goal-manager.ts` snapshot/restore）——**内容有用就能跨压缩存活**，缺陷只是内容空洞。

### 4.2 最小改动（`index.ts:1126-1129`）

把计数串改为结构化内容（机器可读前缀 + 人读尾），数据源复用现有 `after_tool_call` trail：

```ts
// 复用 §5.5 已锁定的数据源：filesTouched 从 after_tool_call 的写类工具取
const filesTouched = collectRecentFilesTouched(state, /* write-class only */);
const tail = truncate(modelTailSummary, /* budget */);
progress: `[Turn ${n}/${max}] files: ${filesTouched.join(',') || 'none'} | ${tail}`,
```

- 截断守 `progress` 字段上限（`types.ts` 现有 500 字符约束）。
- `filesTouched` 只取**写类工具**（`workspace_write`），**不含只读调用**——对齐 §5.5 line 1300、§5.6 line 1336 的 `commandClass` 过滤规则（否则纯分析任务永远"有活动"）。
- `decisions`/`openItems`/`evidenceStatus` 等 §5.5 完整字段**暂不引入**（属完整 ledger 范围）。

### 4.3 与 §5.5 完整 ledger 的关系

- 本改动是 §5.5 的**最小前置/子集**：先填实 `progress`，不新建 `progress-ledger.ts`。
- 未来落 §5.5 时，`progress` 字段从 ledger 摘要派生——**不冲突**，本改动是被取代而非被推翻。
- 落盘根：本改动不新增落盘（`progress` 已在 state，随 `state-persister` 持久化），故**不涉及** §5.5 line 1313 的"落盘根须与 5.1 统一"约束（那是独立 ledger 文件的约束）。

### 4.4 compaction 保真

- `goal-manager.ts` 的 `snapshotGoal`/`restoreGoalFromSnapshot` 已快照 `progress` 字段（string）。结构化内容自动随快照存活。
- ⚠️ 实施时确认快照/恢复路径**包含** `progress`（§5.5 line 1318 提到 P1-11 的 `progress` 恢复优先级不对称 `autopilot-state.ts:125-133`——若快照不含 progress，先修这个）。

### 4.5 测试

- 多轮 run → `progress` 含改过的文件名 + 尾摘要
- compaction 后 → 结构化 `progress` 存活（从快照恢复）
- 500 字符截断不溢出
- 只读任务 → `files: none`（不误报活动）

---

## 5. 前置依赖 —— §5.6 在飞守卫（防 TOCTOU 反噬）

§5.4/§5.7 收紧 evidence 门后，**更多 run 真跑验证命令**。验证命令耗时 >300s 时，`checkStall`（纯静默计时器）会**误报停滞**，与 `await runValidationCommands` 形成 TOCTOU 覆写（巡检写 `retry_queued`，完成处理器用旧快照写 `done`，谁后写谁赢）。§5.7 line 1347 明示"**5.6 先于 5.7**"。

§5.6（line 1321-1340）方向一"在飞守卫"：
- `before_tool_call`（`index.ts:850`）派发后置 `inFlightToolStartedAt`，`after_tool_call`（`:669`）清零——区分"静默"与"等待中"。
- `await runValidationCommands` 期间**同样置该字段**（evidence 也是"在飞长操作"），消除 validation 期误报。
- ⚠️ `agent_end` 与 `before_agent_finalize` 都须清零，防字段悬挂永久禁用 stall 检测。

**落地顺序约束**：若 §5.6 未实施，§5.4（本设计）必须**先做或同批做 §5.6 方向一**，否则收紧的 evidence 门被坏掉的 stall 检测反噬。

---

## 6. 对齐清单（落地必遵，否则静默降级）

| # | 约束 | 位置 | 漏的后果 |
|---|---|---|---|
| 1 | `PauseReason` union 新增需在 `pauseReasonToBlockedReason` 加映射 | `types.ts:3` + `:90` | **编译错误**（W1 已让 total，是安全网） |
| 2 | `BlockedReason` union / `VALID_BLOCKED_REASONS` Set | `types.ts:26` + `:50` | `evidence_missing` 已在（line 31/55），无需改；若新增则两处同改 |
| 3 | `RESUMABLE_BLOCKED_REASONS` allowlist | `state-persister.ts:432` | `evidence_missing` 已 resumable；确认无需改 |
| 4 | projection `canResume`/`completionUnverified` | `src/projection.ts` | 死字段（§5.12 必做1 消费 canResume） |
| 5 | resume setter 收缩 + §5.12 按钮条件同批 | `index.ts:1318` + `ContinuousModeToggle.tsx:168` | 永远点不动的 resume 按钮 |
| 6 | §5.6 在飞守卫先于/同批 | `index.ts:850/669` | TOCTOU 覆写 done/retry |

> 本设计**不新增 PauseReason**（`evidence_missing` 是 BlockedReason 非 PauseReason；skipped→blocked 走 evidence_finished 分支直接写 `blockedReason`，不经 pause）。故约束 1 的编译安全网本设计不触发——但实施者若引入新 pause 路径须遵守。

---

## 7. 落地顺序

1. **§5.6 方向一（在飞守卫）** —— 前置，防 TOCTOU。若已实施则跳过。
2. **§4 进展结构化（progress 填实）** —— 独立、零风险、立即可做。
3. **§5.4 三步 + §5.12 必做1** —— 同批：①evidence-gate 加 `skipReason` ②orchestrator 区分两因 ③resume 守门 + projection 字段 + 按钮条件。
4. **（后续，非本设计）§5.5 完整 ledger** —— progress 字段被 ledger 摘要取代。

---

## 9. 验证（端到端 + 回归）

- `pnpm verify`（lint + typecheck + test + docs:build）—— typecheck 自动守住 `pauseReasonToBlockedReason` total（约束 1）。
- §3.4 contract 测（skipped 两因 / fail-open / canResume）。
- §4.5 测（progress 结构化 + compaction 存活 + 截断 + 只读不误报）。
- 回归：`long-horizon-autonomy.md` §2.7 真实 run 回放仍通过；§3.4 列出的现有测试同步预期后绿。
- 手测：无 WORKFLOW.md 项目 → `done + completionUnverified`；有 WORKFLOW.md 命令但被 allowlist 丢弃 → `blocked/evidence_missing` + 可 resume。

---

## 8. 实现状态核验（2026-08-09，执行前最后确认）

> 用真实源码对照本设计 §3-§5 逐条核验。**必做 4 项 + 选做 T05/T06 均已在代码中实施**（T05/T06 于 2026-08-11 落地）。本设计全部完成。

| 改动 | 状态 | 源码证据 |
|---|---|---|
| §5.6 在飞守卫（T01） | ✅ 已实施 | `index.ts:268`（validation 前置置位，注释 "E6 stall patrol"）、`:811`（evidence 期）、`:912/920/1293`（清零） |
| §5.4a skipped 两因（T02） | ✅ 已实施 | `orchestrator.ts:257-295`（passed→done/not_executed→blocked+evidence_missing/其它→done+completionUnverified）、`evidence-gate.ts:34`（skipReason:'not_configured'） |
| §5.4b resume 守门（T03） | ✅ 已实施（1 处偏差） | `orchestrator.ts:399-419`（RESUMABLE_BLOCKED_REASONS 守卫 + REV-1 unclaimed 修复）、gateway `index.ts:1622` |
| §5.5 progress 结构化（T04） | ✅ 已实施（**超预期**：完整 ledger 非最小子集） | `src/progress-ledger.ts`（LedgerEntry/buildEntry/recordTurn/buildProgressHeadline）、`index.ts:1289`、`continuation-engine.ts:4`（summarizeLedger） |
| AC-NNN 谓词（T05，选做） | ✅ 已实施（2026-08-11，commit bdf4815，autopilot 4.2.0） | `src/acceptance-criteria.ts`：AC 块内嵌 goal 字符串（parse/render/inject），零 schema 变更 |
| size-classifier（T06，选做） | ✅ 已实施（2026-08-11，commit 22c9e23，autopilot 4.3.0） | `src/size-classifier.ts`：确定性精简版（信号词+长度+AC 数 → 4 tier），trivial 降 effort |

**记录的三点（2026-08-11 增补）**：
1. **T03 实现偏差 → 已修复（2026-08-09，对抗 review 实证）**：初始实现未显式检查 reducer no-op，靠 `status==='paused'` 前置——对抗 review（opus×2）实证发现**门 INVERTED**：非可恢复 blocked（含 max_total/token_budget/loop_breaker）因 deriveStatus 映射 `'paused'` 过前置 → `resume()` setter 强制复活（预算/上限绕过）；可恢复路径反而因 reducer 转 claimed 后 `resume()` 抛错。修复：gateway reducer 后检查 `orchestrationState !== 'claimed'` → INVALID_REQUEST；**reducer sole writer**（gateway 不再调 `resume()` setter，构造 resumed 时补 `enabled:true` + 清副状态 + deriveStatus）。附带修复：`stop` 对 paused/done 的 audit 双释放（S8 语义，旧 resume 掩盖）。新增 `tests/resume-gateway.test.ts`（非可恢复拒绝 + no_progress 可恢复成功）；lifecycle T10 改 terminal 拒绝语义。966 测试绿。
2. **E6 dir-2 生产力检测（no_progress）也在代码中**（`orchestrator.ts:33` + `state-persister.ts:561` 同步）——超出本设计 §5 范围，属 E6 完整实施。
3. **五轮对抗 review 修复（2026-08-10/11，commit f96f561）**：(a) `not_executed` 语义扩展——timeout/缺失/allowlist 丢弃的 required 命令全部归 `not_executed`（§3.1 表格"命令缺失/超时/被 allowlist 丢弃"承诺终于闭合，`droppedCommands` 计数 + evaluateEvidence 归类）；(b) `completionUnverified` 仅 done 携带（blocked ≠ completion，§3.1 表格已改）；(c) resume 硬化——reducer 清 pauseReason、facade 前置检查、清 needsCrossTurnResume（防 resume_run 双 kick）、保留 retry 链；(d) S8 refcount 平衡（agent_end 四路径/stall/complete 释放全部 reducer-result keyed）。

**结论**：本设计必做部分 = 已实施工作的事后文档化（对照核验一致）；真正待办 = T05（AC-NNN）/ T06（size-classifier）选做。

---

## 10. 引用

- **既有设计**：`docs/core/autopilot/long-horizon-autonomy.md` §5.4(L1250)/§5.5(L1291)/§5.6(L1321)/§5.7(L1342)/§5.12 · `docs/adr/019-conditional-evidence-judging-boundary.md`
- **审计**：`docs/audits/openclaw-native-vs-autopilot-2026-08-05.md`（E4+E7/E5/E1-E8 ticket 顺序）
- **研究报告**（含 5-agent 对抗 review 全文）：`.claude/plans/users-guanxueliang-desktop-matrix-dynam-happy-sundae.md` Part A–H
- **源码**：`orchestrator.ts:261` · `evidence-gate.ts:23-95` · `index.ts:619`(fail-open)/`:1128`(progress)/`:1318`(resume)/`:850/669`(tool hooks) · `types.ts:3/26/50/90` · `state-persister.ts:432` · `goal-manager.ts` · `workflow-config.ts:26-29/55-111`
- **外部蓝本（参考，不引入）**：`anthropics/cwc-long-running-agents`（demo）· `github/spec-kit`（SDD 工具）· `cobusgreyling/loop-engineering` · zcode `/goal` docs
