# 12 — instinct store 的跨进程 lost-update（缓修：交叉锁）

**What to build:** `.instinct/` 两个 JSONL 族的读-改-写路径（`appendInstinct` 命中重写、`purgeFile` 过期重写）无跨进程串行化。同一 workspace 跑两个 gateway/插件进程（两个终端会话）时，A 读旧内容准备重写、B 追加新行、A 的 rename 覆盖 —— B 的记录被无声抹掉，双方都报成功。

**Blocked by:** None — 但刻意缓修：单写者场景是当前规模（单项目 <100 条 instinct）的主流，锁引入的新失败模式（死锁、陈旧锁清理）在无证据前不值当。

**Status:** deferred — 0.3.1 已做的缓解：唯一 tmp 名（`.<pid>.<seq>.tmp`）+ 年龄门控清扫（60s）消灭了 tmp 碰撞与活写者被清扫两条确定性腐败路径；剩余的是 lost-update 窗口（读-到-改名之间）。

## 任务（真做时）

- [ ] mkdir 型建议锁（`.instinct/.lock`，O_EXCL 语义）包住两个重写点；持锁窗口 <100ms，陈旧锁（mtime > 5s）可窃取
- [ ] 锁不可得时的策略：等待重试（上限 ~200ms）后放弃该次写入并计入 failure counter —— 降级为丢这条而非死等
- [ ] 测试：双进程并发 append + purge 的交叉矩阵（可用 worker_threads 模拟）

## 参考

`packages/instinct/src/store.ts` 的 `appendInstinct` / `purgeFile`；ADR-005（本仓把交叉进程状态竞争视为真实威胁）。发现于 2026-09-19 六路 finder code review（finder-D/finder-E 独立报告）。
