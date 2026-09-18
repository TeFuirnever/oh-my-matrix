# 11 — instinct observer 的两个已发货缺口

**What to build:** `packages/instinct` v0.1.0 的 observer 有两个缺口，与 ticket-09 的 extractor 相互独立，可并行或先做。

**Blocked by:** None

**Status:** done — cb90175

**背景:** 2026-09-18 核对 ticket-09 时发现。设计文档（`docs/design/ecc-intake-recommendation.md` §3.1 #1）要求 observer 具备「10MB rotation / 30 天 purge / secret scrub」，实现只落地了 rotation 和 scrub。

## 任务

- [x] `.instinct/` 加进 `.gitignore`。现在它不在里面，意味着 `observations.jsonl` 会被提交——即便内容经过 `scrubSecrets`，把每次 tool 调用的输入输出摘要写进仓库历史也不是预期行为 — `.gitignore`
- [x] 30 天 purge：`src/store.ts` 只有 size-based rotation（`MAX_FILE_BYTES = 10 MB`），没有任何基于时间的清理逻辑 — `purgeExpired()`，`index.ts` 在 `session_start` 召回前调用
- [x] purge 的测试，含边界：全部条目过期时不留空文件或空目录；purge 失败时不抛（与 `appendObservation` 的 never-throw 契约一致）— `tests/purge.test.ts`（13 例，含本就为空的文件、崩溃遗留的 `.jsonl.tmp`、前缀相同的兄弟族、不可读目录、逐文件失败计数不抛）

## 票间依赖

本票的 purge 只覆盖 `observations.jsonl`。ticket-09 会新增第二个文件族 `instincts.jsonl`。实现 purge 时按文件族参数化，或在 ticket-09 里显式扩展——ticket-09 的任务列表已记这一条。

## 参考

`docs/design/ecc-intake-recommendation.md` §3.1 #1；`packages/instinct/src/store.ts`。
