# Autopilot — OMM 侧实现状态（2026-08-08）

> **定位**: 本份是 **OMM 仓**（`packages/autopilot`）的实现状态记录，与 `long-horizon-autonomy.md`（**已弃用**，权威 v2.2 在 MA 仓 `MatrixAssistant/docs/core/autopilot/long-horizon-autonomy.md`，勿改本份）互补。设计文档是方案；本份是「OMM 侧落地了什么」的记账。
>
> **更新**: 每次 OMM 引擎改动合入 master 后更新。2026-08-08 第三阶段（E2–E13 全落地）。

## 已落地（master，PR #134–#147）

| ticket | PR | 内容 | bump |
|---|---|---|---|
| E8 | #134 | checkpoint 触发 + 阈值修正 | minor |
| E10 | #135 | 长尾修正（maxBuffer 冤杀、修复轮 premium、isRunStuck 退避守卫、删死事件）| minor |
| E2 | #136/#137 | 墙钟 + 成本硬上限（60s 巡检、hard_stop 绕过 TENSION 3、winddown）| minor |
| E3 | #136/#137 | 错误分类重做（429/529/网络 errno 可恢复 + 长退避 + Retry-After；锚定匹配）| minor |
| E5 | #138/#139 | 进展台账（结构化 ledger 替换 Turn N/M 计数串；exec-only 过滤）| minor |
| E9 | #140 | 删 `workflow.workspace.root`（ADR-008，从未消费）| **major** |
| E13 | #141/#142 | 显式 `autopilot.resume_run` RPC（P3-29 OMM 半：crash-recovery 不再 flag 隐式续行）| **major** |
| E6 | #143 | 停滞检测双向修：在飞守卫（30min cap）+ no_progress 生产力检测 | minor |
| E7 | #144 | 中途 Evidence Gate（每 N 轮跑 validation，早期纠偏）| minor |
| E4(1-2) | #145 | evidence gate skipped 区分（not_configured→done / not_executed→blocked evidence_missing）| minor |
| E12(fold) | #146 | needsCrossTurnResume 全 reducer 写（cross_turn_enqueued + cross_turn_degraded_silent）| minor |
| — | #147 | RESUMABLE mirror 奇偶修复（E6 漏同步 no_progress）| fix |

**发版**: `changeset version` 已消费全部 pending changesets → **autopilot 4.0.0**（major：E9/E13）+ **dynamic-workflows 1.0.0**（openclaw 基线 2026.7.1-2）+ **permission-policy 0.1.4**（共享 logger 提取）。**2026-08-09 已发布 npm**（tag：`autopilot-v4.0.0` / `dynamic-workflows-v1.0.0` / `permission-policy-v0.1.4`，release notes 见 GitHub Releases）。发布实操与坑（镜像 registry / 2FA / sync-plugin-versions）见 `docs/runbooks/npm-release.md` + memory `npm-publish-flow`。

## 已发版（2026-08-10/12，autopilot 4.1.0→4.2.0→4.3.0→4.4.0 / dynamic-workflows 1.1.0→1.2.0 / instinct 0.1.0 新包）

| 变更 | 内容 | 包/版本 |
|---|---|---|
| evidence gate fail-closed 完整化 | timeout/缺失/allowlist 丢弃的 required 命令 → `not_executed` → blocked `evidence_missing`（可恢复，设计 §3.1 闭合）；`validation.droppedCommands`；not_executed blocked 补 `enabled:false` | autopilot 4.1.0 |
| resume 语义硬化 | reducer 清 `pauseReason`；gateway facade 前置检查；清 `needsCrossTurnResume`（防双 kick）；保留 retry 链；清 stale inFlight | autopilot 4.1.0 |
| completionUnverified 语义 | 仅 done 携带；projection 仅 done 透出 | autopilot 4.1.0 |
| S8 audit refcount 平衡 | 释放全部 reducer-result keyed（agent_end 四路径/stall/complete/patrol） | autopilot 4.1.0 |
| AC-NNN goal 谓词 | goal 携带结构化验收标准（Scenario/Action/Expected/Must-not/Verification/Priority），AC 块内嵌 goal 字符串，零 schema 变更 | autopilot 4.2.0 |
| task-size classifier | goal → trivial/small/standard/large（信号词+长度+AC 数）；trivial 前 3 轮 low effort 后自动升级 | autopilot 4.3.0 |
| 确定性任务预筛 | `agent_turn_prepare` hook（priority 12，主会话）读 prompt → fan-out 信号 → appendContext 指引；跳过 subagent | dynamic-workflows 1.2.0 |
| skill 触发词 | description "use proactively" + 通用场景触发词（EN+ZH） | dynamic-workflows 1.2.0 |
| validate-prose 脚本 | OpenProse 不可用时的独立 5-check 验证（node，8 单测） | dynamic-workflows 1.2.0 |
| evidence-coupled no_progress | `lastProgressTurn` 记账——churn 不通过验证仍 trip no_progress；`skipped`+`not_executed` 不算 progress（F6） | autopilot 4.4.0 |
| checkpoint schemaVersion | `schemaVersion` + `migrateCheckpoint` v1→v2（legacy `lastValidatedTurn` normalize + 完整 `EvidenceSummary` 恢复）；未来高版本拒绝；migration `progressGrace` 一次性豁免（F3 package 侧，host patrol 待 consume） | autopilot 4.4.0 |

> ⚠️ **4.4.0 host 接入前置**：02 的 evidence-coupled 回归（F1 stale stamping / F2 audit-refcount / F3 host grace wiring）在 host gateway `index.ts`，不在本 package。升级 4.4.0 安全（08 立即受益），但 **接入 evidence-coupled no_progress 前必须修 F1/F2 + consume `hasMigrationGrace`**。详见 `docs/design/autopilot-enhancement-design.md` §C1。
| **instinct 新包** | 跨会话 context 记忆：after_tool_call 观测（脱敏）→ `.instinct/observations.jsonl`；session_start 回忆。闭合第三缺口 | instinct 0.1.0 |

杂项：runtimeMs 终止冻结、evidenceSkipReason 透出、ledger fold 去重、legacy resume() setter 删除、eslint 忽略 worktree。

**发布后补强（2026-08-09）**：
- **E13 双花闭环**：resume_run RPC 成功即经 reducer 消费 `needsCrossTurnResume`（第二次调用拒绝）+ `shouldCheckpoint` 持久化 flag 翻转（重启腿不重开 P3-29）。
- **覆盖率门禁生效**：3 包 vitest coverage 阈值 + CI/`pnpm verify` 强制执行（autopilot 93.5/85.8/96.3/93.5、dw 89/75/100/89、pp 80/92/94/80 实测）。
- **host smoke 补跑通过**：MA 宿主升级 4.0.0 + `scripts/smoke-plugin-runtime.mjs`（真实 SDK：12 hooks + 7 RPC + destructive blocked / safe allowed）——host-deploy §5 兑现。**（2026-08-18 核实修正：脚本仅存在于 MA 悬空 commit `ddb6246e`，未合入任何分支，当前 dev 工作区不可用；恢复/重建由 issue #171 跟进。）**

## 已发版（2026-09-19/20，npm 均已验证）

| 变更 | 内容 | commit |
|---|---|---|
| size-classifier → effort/model 接线 | `taskTier` 此前只喂 `resolveThinkingIntensity`，model routing 完全忽略。现两端都读：continuation 轮（`totalContinuations >= 2`）`small` 封顶 medium、`large` 钉 high；`small` 仍让位于显式 `configIntensity:'low'`（不覆盖运营方成本控制）。初始轮与验证阶段仍优先于 tier | `587def4` |
| large → `initialTurnTier` | `large` 在 continuation 轮复用 `initialTurnTier`，不落回更弱的 `defaultTier`。**刻意不设硬编码 premium floor**——`ModelTier` 是无序字符串，无 rank 即无 floor；运营方下调 `initialTurnTier` 即等于全局退出 premium | `587def4`、`4f5e615` |
| projection modelTier 一致性 | `projection.ts:86` 补传 `taskTier`，投影值与实际下发 gateway 的 override 对齐（此前 large 任务实跑 premium、面板显示 standard） | `9a787e6` |
| crash-recovery 两处加固 | `isActiveOrchestrationState` 改由 `deriveStatus` 推导（消除手工状态表漂移）；`list_resumable_sessions` 跳过 `sessionKey` undefined（半写 checkpoint）与 `enabled:false`（deactivate 中途崩溃）两类条目 | `830f422`、`4f5e615` |
| instinct 30 天 purge + `.instinct/` gitignore | 补齐设计 §3.1 #1 的第三条保证（rotation/scrub 已在 0.1.0）。`purgeExpired()` 按 file family 精确匹配（`<family>.jsonl` / `<family>-N.jsonl`），删空文件与空目录、清崩溃遗留的 `.jsonl.tmp`，temp+rename 重写，never-throw + 失败计数；`session_start` 召回前调用。**刻意的数据损失**：`ts` 不可读的行被丢弃——合法 JSON 但缺 `ts` 的行本可召回，但无法确立年龄的记录永远满足不了 30 天上界（ticket-11） | `cb90175` |
| instinct extractor（tool 路线） | `instinct_record` tool（`registerTool` + manifest `contracts.tools`）+ 两段 recall；`session_start` 召回在此版本已迁 `agent_turn_prepare`（宿主丢弃 void hook 返回值，注入只认 prompt-injection hooks）。去重 text+hash 双匹配，`appendInstinct` 返回三态回执（ticket-09） | `1270e5c`、`46823a1`、`2481d14` |

> 📌 **发版事实**：autopilot `4.5.0` + instinct `0.2.0`（2026-09-19，tag 齐全）；instinct `0.3.0` 合入但**从未发布 npm**（tarball 缺 `openclaw.plugin.json`，0.2.0/0.3.0 从 npm 均不可安装）；`0.3.1`（host 契约 + 打包修复，首个可安装版）与 `0.3.2`（截断安全去重）于 09-19/20 发布，registry 验证 8/8。

> 📌 `list_resumable_sessions` **有意只含活跃 orchestration state**。blocked 但可恢复的 run 走 `canResume` 独立通道（`projection.ts:143` + ticket-07 host 按钮），不经 `resumeRestoredRuns`——两轮 review 都提过这点，结论是不改。

## OMM frontier 剩余（0 张可立即开）

| 项 | 阻塞 |
|---|---|
| E4 step3（resume 守门：resume_requested no-op → respond false）| **M2**（MA `canResume` 字段，跨仓同批）|
| E12 resume setter fold + 6-aux invariant | ←E4 step3 |
| X1（vendor 同步脚本）| MA `resources/claw-plugin/` 目标 |
| M2–M5 | MA 仓 |
| T0（loop 活性实跑验证）| 非代码，需运行系统 |

**T0 重审**：T0 是运行时验证，非代码依赖——E6/E7/E4 顶着 T0 标签落地证明（E2 亦同）。

## 跨仓依赖（OMM 侧已交付，消费侧在 MA）

- **E13 无双花端到端**：MA driver 须消费 `autopilot.resume_run` RPC（crash-recovery 恢复的 mid-cross-turn run 现等待显式 RPC 或 stall 回落）。OMM 侧已交付 RPC 定义 + 处理。
- **M2**：resume 按钮须用引擎新增的恢复可恢复性判定（E4 step3）——现按钮只查 `isPaused`。
- **X1**：引擎产物 vendor 同步（版本错配防复发，M4 只治症状）。

## 审计对照（autopilot-deep-review-2026-07-31）

2026-08-08 第三轮 doc-review（3 agents）结论：**审计发现的 P0 大多已被 E2–E13 修复**（3.1 错误分类、3.2 在飞守卫、3.3 硬上限、3.4 skipped 区分、3.5 isRunStuck、3.8 maxBuffer、3.10 台账）。唯一活 bug（RESUMABLE mirror 漂移）已修 #147。审计文档的 file:line 引用已随代码移动而漂移（历史记录，不追改）。

## 相关文档

- 设计权威份（MA v2.2，勿改本份）：`MatrixAssistant/docs/core/autopilot/long-horizon-autonomy.md`
- OMM 份（**弃用**）：`docs/core/autopilot/long-horizon-autonomy.md`
- 审计：`docs/audits/autopilot-deep-review-2026-07-31.md`
- 设计稿：`docs/design/autopilot-enhancement-design.md`（Part A = verification-floor 落地，已并入此合一设计稿）
- ticket 索引：`.scratch/README.md`
