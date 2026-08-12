# 05 — Ledger-output backstop on 完成判定

**What to build:** 完成判定（模型措辞正则命中）要求最近台账有实际产出（改过文件/跑过命令）才信——防"嘴上说完成但啥也没干"。

**Blocked by:** 02 — Evidence-coupled 记账（产出语义与"验证才算 progress"一致后，backstop 判定才稳）

**Status:** blocked — 记账模型限制（2026-08-11 实现验证后撤销）

**为什么 blocked（实现验证记录）：**

1. **判据不可行**：ledger 只记 write/shell 类工具（`index.ts:910-918`，read-only 调用记录 nothing）。空 ledger 判据会**误拦真实只读/纯分析 run**（模型只读不改、不跑命令 → ledger 空 → 完成声明被拦 → revise 死循环 → max_total 失败）——生产 bug。
2. **死代码陷阱**：空轮从不记 entry（agent_end `hasActivity` gate），有 entry 时恒有产出——"最新 entry 无产出"判据结构上不可达。
3. **测试破坏**：14 个集成测试（audit refCount / evidence wiring / plugin-entry / E2E）mock 完成轮零 tool 调用，任何产出判据都会拦它们——mock 简化 ≠ 生产语义。
4. **正确实现需记账扩展**：判据"完成轮无 tool 调用"需要把 read-only 工具调用也记入台账（tool-调用级记账），超出本 ticket 范围。

**现有覆盖（05 撤销后的等效防护）：**
- P1-2 轮数门：totalContinuations < 2（可验证任务 3）不信完成措辞
- evidence gate：无验证命令 → skipped → done 但 completionUnverified
- 02 lastProgressTurn：no_progress 暂停（无 validated 产出）

**重做前提（新 ticket）**：先扩展 ledger 记账覆盖 read-only 工具调用（tool-调用级），再以"完成轮零 tool 调用"为判据。

- [ ] `isTaskComplete` 命中但最近台账无实际产出 → 不判完成（继续/revise）
- [ ] 有产出才信完成措辞
- [ ] 契约测试：空产出完成声明被拦
