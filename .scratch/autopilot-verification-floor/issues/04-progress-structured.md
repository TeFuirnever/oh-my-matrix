# 04 — §5.5 进展结构化（最小子集）

**What to build:** 每轮结束时 progress 从计数串升级为结构化内容——本轮改过的写类文件 + 模型尾摘要。progress 已随每轮注入续轮指令、已随压缩快照存活——内容一改，长程任务跨压缩可追溯。只读任务不误报活动。

**Blocked by:** None — can start immediately（与 02 并行；实施建议同批落地）

**Status:** ✅ 已实施且超预期（2026-08-09 代码核验：完整 `progress-ledger.ts`（LedgerEntry/buildEntry/recordTurn/buildProgressHeadline）+ `index.ts:1289` 消费 + `continuation-engine.ts:4` summarizeLedger 注入 + state-persister/types/projection 全带 ledger——不止最小子集，§5.5 完整 ledger 已落地）

- [ ] 多轮后 progress 含本轮写类文件列表 + 尾摘要（截断到既有上限）
- [ ] 只读任务 progress 文件列表为空（不误报活动）
- [ ] 压缩后结构化 progress 从快照存活恢复
- [ ] 写类文件判定复用既有工具分类，不含只读调用
