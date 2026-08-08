# E12 — ADR-020 状态机收尾：reducer 成 coupled aux 唯一写者（steps 4-6）

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: S-1 / TD-3（状态机多写者遗留债）；ADR-020 steps 4-6
**被阻塞**: 无
**设计文档**: ADR-020（`docs/adr/020-reducer-sole-writer-extends-to-coupled-aux.md`）；design.md §8.2.1

---

## 问题

ADR-020 steps 1-3 已落：`cross_turn_degraded`、`cross_turn_resume_consumed` 两个事件进 reducer（`orchestrator.ts`），`complete()` 后门已删（零生产调用者）。但 reducer 至今只是 `status` + 这三个已迁移转换的唯一写者。

`autopilot-state.ts` 的 5 个命令式 setter（`activate/pause/complete/resume/deactivate`）**仍在写** coupled aux 字段（`enabled/pauseReason/toolErrorCount/lastToolError/needsCrossTurnResume/degraded`），裸 `{...state}` spread 仍在 transition 路径上。`complete()` 零调用却仍导出。`status-invariant.test.ts` 不断言这 6 字段 reducer-only（ADR 自承 enforcement gap，待 step 6 补）。

净效果：H1 类双写 bug 的结构性隐患仍在——transition 逻辑与其 aux 重置散落在 reducer / setter / inline spread 三处，正是 PROD-7 / LOGIC-4 / H1 / GAP-* 等 bug 的聚集根因。

## 做什么

按 ADR-020 expand-contract 的 **contract 阶段**收尾，沿用前 3 步的 dual-track（事件先就位、再删 setter），每步独立可发、可 bisect：

- **step 4**：`activate/pause/resume` 折进 reducer。已有 `activate_requested/pause_requested/resume_requested` 事件承载 transition；把各自的 coupled aux 重置随事件**原子带入** reducer handler；迁移调用点，删 setter 生产调用。
- **step 5**：`deactivate` 折进 reducer（`stop_requested` 事件）；`complete` 随之**彻底删**（已零调用者，不再仅是「零调用但导出」）。
- **step 6**：删 setter 残留的 `if (status !== X) throw` 守卫，转为 **warn**（保持 ADR-020「warn-don't-mask」姿态，保留 bug 发现价值）+ 删 apology 注释；`status-invariant.test.ts` 加断言：6 个 coupled aux 字段仅由 reducer 事件 handler 写。

`permissionAudit` 仍是 index.ts 观察 ring buffer，**不折进** reducer（ADR-020 Decision 4 明确排除）。

## 验收

- [x] ~5 个命令式 setter 零生产调用者~ → **部分**：activate/pause/deactivate 已折（零调用）；`complete` 本就零调用；**resume 仍被调用**（见下方阻塞）
- [ ] reducer 是 6 个 coupled aux 字段的唯一写者 → **5/6**：`enabled/pauseReason/toolErrorCount/lastToolError/degraded` 已 reducer-only；`needsCrossTurnResume` 仍由 2 处 bare spread 写（见下方阻塞）
- [ ] `status-invariant.test.ts` 加 6 字段 reducer-only 断言 → **延后**（依赖 needsCrossTurnResume 折完）
- [x] step 4/5 各自独立可发（commit a534c60 + 0bc9304）
- [x] 全量 `pnpm -r typecheck && pnpm -r test` 绿（autopilot 869 / dynamic-workflows 68 / permission-policy 247）

## 状态（2026-08-08 实施更新）

**已落地（branch `e12-adr020-reducer-sole-writer`）**：
- `a534c60` step 4：activate/pause/deactivate 折进 reducer（pause_requested/stop_requested 携带 coupled aux 重置；activate_requested 已等价，删冗余 setter 包装）
- `0bc9304` step 4：degraded 生命周期折进 reducer（新增 `degradation_marked`/`degradation_cleared` 事件，pure flag flip，不动 lastActivityAt——canary 失败时动它会掩盖停滞）

**剩余工作被两条外部依赖 gate**：
1. **resume fold → E4（P1-8）**：`resume()` setter 强制 claim、绕过 reducer 可恢复性守门。折它会静默改变不可恢复 pause（如 `max_total_reached`）的 resume 语义——这是 E4 的决策，不是机械折。lifecycle e2e「resume from paused」锁定了现状。
2. **needsCrossTurnResume 2 处 bare spread（index.ts:568 跨轮成功、:1083 canary 失败兜底）→ E13（P3-29）**：这两处即跨轮握手 = 网关重启双花攻击面。E13 会重做 crash-recovery 的 needsCrossTurnResume 处理，先折会撞 E13 设计。
3. setter 删除（activate/pause/complete/deactivate）+ throw-guard + 6-aux invariant → 上述两条落地后一并做（invariant 要全 6 字段 reducer-only 才成立）。

**净结论**：E12 做到 E13/E4 边界，5/6 aux 字段已 reducer-only。收尾待 E4 + E13。
