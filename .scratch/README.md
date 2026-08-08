# Autopilot 长程自主运行 — Ticket 索引

**设计文档（唯一真相源）**: [`docs/core/autopilot/long-horizon-autonomy.md`](../../docs/core/autopilot/long-horizon-autonomy.md) v2.1
**创建日期**: 2026-08-01
**基线**: MatrixAssistant `6b8c17fdc` (dev) · oh-my-matrix `b39deb6` (master, autopilot v3.1.0)

> **状态 reconcile（2026-08-08）**：设计文档已对齐 8-08 代码状态（HEAD `de492fc`，工作树干净，代码核对一致）。本次 reconcile（聚焦 OMM，MA 侧 ticket 不动）：
> - **ADR-020 steps 1-3 done**（`cross_turn_degraded` / `cross_turn_resume_consumed` 事件进 reducer + 删 `complete()` 后门）→ 新增 [E12](issues/E12-adr020-reducer-sole-writer-completion.md) 收尾 steps 4-6。
> - **M1 / §5.10（MA 侧主进程单驱动）已于 8-08 落地代码**——这是 [P3-29（E13）](issues/E13-restart-double-spend.md) 成为活缺口、P3-28 成为待偿债的触发点。
> - **新增 P3-29（E13）**：网关重启后 crash-recovery 重置 flag × 内存去重 → 双花模型预算。
> - **P3-28 暂缓（非 OMM 范围）**：根因在 openclaw「非空消息要求」，OMM 无可改，待 openclaw 能力决策——见「明确不做」。
> - **T0 仍进行中**：M1 机制已修，但「loop 真能多轮转」待 §5.0 运行时验证。

> **状态 reconcile（2026-08-08 第三阶段 · HEAD `fabdad9`）**：本会话落地**全部**无阻塞 OMM 引擎 ticket，**OMM frontier 穷尽**。
> - **已合入 master（PR #134–#146）**：E8、E10、E2、E3（同批）、E5、E9、E13、E6、E7、E4(step1-2)、E12(fold)，各配深度 `/code-review` + follow-up fix。E1、E11、E12(部分) 于前一阶段落地。
> - **T0 重审**：T0 是运行时验证（非代码依赖），非硬阻塞——E6/E7/E4 顶着 T0 标签落地证明。真硬阻塞仅 M2（跨仓，E4 step3）+ MA 侧。
> - **E6 双向修**（P0-6）：在飞守卫（inFlightToolStartedAt，长工具不误报）+ 生产力检测（no_progress，N 轮零产出→pause）。
> - **E7 中途 gate**：每 N 轮（默认 5）跑 validation，早期纠偏。
> - **E4 step1-2**：evidence gate skipped 区分（not_configured→done / not_executed→blocked evidence_missing）。step3（resume 守门）←M2 缓。
> - **E12 fold**：needsCrossTurnResume 在 index.ts 全 reducer 写（cross_turn_enqueued + cross_turn_degraded_silent）。resume setter 是唯一余非 reducer 写点 ←E4 step3。
> - **E2/E3/E9/E13 = breaking**（changeset major）——下次发版是大版本，捆绑 E5/E6/E7/E4/E12 minor。
> - **OMM frontier 剩余 = 0 张可立即开**：E4 step3 ←M2、resume setter ←E4 step3、X1/M2-M5 ←MA、T0 ←非代码。

每张 ticket 只写「做什么 + 验收 + 阻塞边」。**背景、证据、`file:line` 全在设计文档**，不在此复述——ticket 里的章节号即索引。

---

## 两仓分布

| 仓 | Ticket | 说明 |
|---|---|---|
| **oh-my-matrix** `packages/autopilot/` | E1–E11 | 引擎核心，全部 P0/P1 |
| **MatrixAssistant** | M1–M5 | 消费侧，**无新 UI 界面** |

**两侧可并行**——`5.6 → 5.10` 的前置关系已论证解除（设计文档 §7「实施顺序」）。

### MA 对 OMM 的依赖（实测逐张核对）

| Ticket | 依赖 OMM | 依据 |
|---|---|---|
| M1 跨轮驱动 | **否** | 消费的 `needsCrossTurnResume`（`projection.d.ts:11`）、`totalContinuations`（`:6`）**已存在**。原稿混进的「崩溃恢复补 kick」代码在引擎侧，已拆为 E11 |
| **M2 resume 死按钮** | **是（硬依赖 E4）** | `canResume` 字段**当前不存在**，须 E4 新增。且是**跨仓同批**，非单纯等字段 |
| M3 i18n 穷举 | 否 | 映射现有 union，MA 自足。⚠️ E2/E4/E10 新增 reason 时需回来同步 |
| M4 安装期 bug | 否 | 纯 MA 资源 / 主进程 |
| M5 托盘 | 否 | `lastActivityAt`（`projection.d.ts:27`）已存在 |

**净结论：5 张里 4 张零依赖，可与引擎侧完全并行。**

---

## 阻塞图

```
T0（loop 活性定位 · 非代码）
  └─→ 阻塞 E2 E4 E6 —— 这三项的落点取决于 T0 结论

E1（checkpoint 根统一）
  └─→ E5（台账复用同一根）
        └─→ E6（生产力检测消费台账）
              └─→ E7（中途 gate 拉长在飞时间，须先有在飞守卫）

E3 ⇄ E2 必须同批 —— 否则「更能活」而「无刹车」

E4 ⇄ M2 必须同批（跨仓）—— 见 M2

M1 ／ E11 互补但不互阻 —— M1 驱动活着的 run，E11 踢崩溃恢复的 run

无阻塞，可立即开工：E1 E3 E8 E9 E10 E11 E12 · M1 M3 M4 · X1

E13 ← E11（同一 crash-recovery 恢复路径；建议 E12 之后做——两者都动 needsCrossTurnResume / reducer 区）
```

**最长链**：`E1 → E5 → E6 → E7`（四级）。E1 是引擎侧关键路径起点，建议与 T0 并行开工。

⚠️ **M5 无硬阻塞但建议 M1 之后做**——它的数据源在 M1 的主进程驱动器里。

⚠️ **反直觉的一条**：`E4 → M2` 是**跨仓同批**约束。E4 单独上线会让 resume 按钮变成永远点不动的死按钮，比现状更糟。M2 只有一行条件改动，但不能省、不能晚。

⚠️ **X1 应在第一张引擎 ticket 落地时就跑通**——本轮有 10 张引擎 ticket，每张都要重新 vendor。没有同步脚本的话，M4 修好的版本错配会在第一次引擎改动后原样回来。

---

## Ticket 列表

### 前置

- [T0](issues/T0-loop-liveness-diagnosis.md) — loop 活性定位（**非代码**，阻塞 E2/E4/E6）

### oh-my-matrix 引擎侧

- ✅ [E1](issues/E1-checkpoint-root-unify.md) — checkpoint 根统一（P0-2）·已合入
- ✅ [E2](issues/E2-wallclock-cost-caps.md) — 墙钟 + 成本硬上限（P0-5）·PR #136/#137
- ✅ [E3](issues/E3-error-classification.md) — 错误分类重做（P0-3）·PR #136/#137（与 E2 同批）
- 🟡 [E4](issues/E4-evidence-gate-resume-guard.md) — `skipped ≠ passed` + resume 守门（P0-4, P1-8）·**step1-2 done**（PR #145，skipped 区分）；step3（resume 守门）←M2 跨仓
- ✅ [E5](issues/E5-progress-ledger.md) — 进展台账（P1-11, P1-13）·PR #138/#139
- ✅ [E6](issues/E6-stall-detection-inflight-guard.md) — 生产力型停滞检测 + 在飞守卫（P0-6, P1-14）·PR #143
- ✅ [E7](issues/E7-midrun-evidence-gate.md) — 中途 Evidence Gate（P0-4 放大因素）·PR #144
- ✅ [E8](issues/E8-checkpoint-trigger-threshold.md) — checkpoint 触发与阈值修正（P3-20, P1-9）·PR #134
- ✅ [E9](issues/E9-remove-dead-workspace-root.md) — 删 `workflow.workspace.root`（P2-15）·PR #140（breaking）
- ✅ [E10](issues/E10-longtail-fixes.md) — 长尾修正集（P1-10, P2-18, P3-20）·PR #135
- ✅ [E11](issues/E11-crash-recovery-kick.md) — 崩溃恢复补 kick（P0-7 恢复路径分支）·已合入
- ✅ [E12](issues/E12-adr020-reducer-sole-writer-completion.md) — ADR-020 状态机收尾 ·steps 1-5 done（fold PR #146）；**6-aux invariant 待 resume setter fold**（←E4 step3/M2）
- ✅ [E13](issues/E13-restart-double-spend.md) — P3-29 网关重启后双花预算（显式 resume_run RPC）·PR #141/#142（breaking，OMM 半；MA 消费侧待跨仓）

### MatrixAssistant 侧

**MA 侧 5 张里 4 张零 OMM 依赖，仅 M2 硬依赖 E4**（见下方「MA 对 OMM 的依赖」）。

- [M1](issues/M1-cross-turn-driver-main-process.md) — 跨轮驱动移入主进程（P0-7, P0-1b）
- [M2](issues/M2-resume-dead-button.md) — resume 死按钮修正（**依赖 E4 的 `canResume` 字段，且须与 E4 同批**）
- [M3](issues/M3-i18n-exhaustive-mapping.md) — `PauseReason`/`BlockedReason` 穷举 i18n
- [M4](issues/M4-install-path-version-bugs.md) — 安装期两个 bug
- [M5](issues/M5-tray-liveness.md) — 存活指示托盘 tooltip

### 跨仓基础设施

- ⏸ [X1](issues/X1-vendor-sync-automation.md) — 引擎产物 vendor 同步脚本 ·**暂缓（跨仓基建）**：vendor 目标 + `plugin-registry.json` 在 MA 侧，本仓不可达

---

## 明确不做

- **运行面板**：`347df92a3`（2026-06-10）已删，备份 `origin/symphony`。2026-08-01 二次确认不恢复。理由与代价清单见设计文档 §8.1
- P1-12 可观测性标记为**已知接受**，仅 M5 覆盖存活指示
- **P3-28 transcript 泄漏（暂缓 · 非 OMM 范围）**：M1 落地后主进程发非空占位 `'[autopilot: next turn]'` 绕过 gateway「非空消息要求」，但该串落进 user transcript。**根因在 openclaw**（非空消息要求），OMM 无可改——需 openclaw 提供 ephemeral/system 续轮 RPC 或 `chat.send` 非持久化标志，plugin 侧再消费。裁决：不在 MA renderer 做哨兵过滤（化妆 + 引入 driver↔renderer 耦合）。待 openclaw 能力决策后另开票。
- **跨仓依赖（E13）**：P3-29 的端到端「网关重启无双花」需 MA driver 侧消费引擎新增的显式 resume RPC。OMM 侧（E13）交付 RPC 定义 + 处理；MA 侧消费不在本批范围。
- **X1 暂缓（跨仓基建）**：vendor 同步脚本的产物落在 `MatrixAssistant/resources/claw-plugin/` + 改 MA 的 `plugin-registry.json`。MA 不在本仓 + 本会话硬约束「MA 不要管」。需在 MA 仓本地或在打通两仓的 CI 里做。M4 修的是当前症状，X1 防复发——X1 不落地则每次引擎改动后 M4 的版本错配会原样回来（已知债）。
