# E10 — 长尾修正集

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P1-10、P2-18、P3-20 的长尾项
**被阻塞**: 无
**设计文档**: §5.13

---

## 1. maxBuffer 冤杀 verbose 测试（P1-10）

`command-runner.ts:100` 用 `execFile` 默认 maxBuffer（Node 22 = 1 MiB/流）。输出量大的**合法通过**的测试套件会超 buffer 抛错 → 判 failed → 证据门失败 → 白重试到 maxRetries → blocked。

修法两步，**第二步不能省**：

1. 显式设 `maxBuffer`（建议 10 MiB）；
2. **区分溢出错误**：`err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` 时归为独立状态（如 `'output_overflow'`）而非 `'failed'`。当前溢出与真实测试失败**无法区分**——只调大 buffer 是把问题推后，不是修好。

更彻底：改 `spawn` + 流式聚合，只保留尾部 N KB。

## 2. 修复轮 tier 偏低（P2-18）

`model-routing.ts` 增相位判定：`evidence.status === 'failed'` 后的修复轮升 `premium`。

当前 `initialTurnTier` 给**开局轮** premium 而**修复轮**拿 `defaultTier` —— 最需要能力的相位被降配。

⚠️ **不要**改验证期的 `effort='low'`。审计称其为「相位倒挂」是**措辞错误**：验证期跑的是 shell 命令不是 LLM 推理，low 是正确选择（`effort-injection.ts:37-44` 注释明示 "fast execution"）。

## 3. 死 reducer 事件（P2-18）

`workspace_failed` / `permission_denied` 定义了但**从未派发**（`orchestrator.ts:117-121`）。二选一：

- 派发它们（`workspace_failed` 在 activate 校验失败时、`permission_denied` 在 host veto 后）；
- 或删除，并在注释说明「工具阻断走 host veto，不经 orchestrator」。

**不要留着不派发。** 若选派发，MA 侧 M3 的 i18n 映射要同步。

## 4. legacy setter 收尾（W1a）

E4 第三步已收缩 `resume()`；`pause()` 同理应改为纯 reducer dispatch。这是 fix-checklist 的 W1a——E4 完成了其中最危险的一半。

## 5. `isRunStuck` 退避守卫（P2-17）

- 加 `nextRetryAt` 在未来则不判 stuck（当前对任何 `retry_queued` 一律判卡死，含正常退避中的 run）；
- 同步改 `tests/autopilot-activate-idempotent.test.ts:49-52` —— **该测试钉死了当前行为**，不改会红；
- 旧 run 丢弃前补 `deleteCheckpoint` 消除泄漏。

⚠️ 审计称此缺陷导致「同 goal 新旧两 run 并存」——**后果判断错误**。调用方先删旧 run 再插新 run（`index.ts:1268-1284`），不并存。真实代价是**旧 checkpoint 泄漏到 24h TTL**。修的是泄漏，不是并发。

## 6. 过期注释

`orchestrator.ts:51`。

## 验收

- [ ] verbose 测试通过时不再被冤杀
- [ ] 溢出与真实失败**可区分**（独立状态码）
- [ ] 修复轮拿 premium tier
- [ ] 验证期 effort **保持 low**（不要"修"它）
- [ ] 死事件已派发或已删除，无第三态
- [ ] `pause()` 走 reducer
- [ ] 退避中的 run 不判 stuck，旧 checkpoint 无泄漏
