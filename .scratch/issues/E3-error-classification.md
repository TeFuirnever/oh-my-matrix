# E3 — 错误分类重做

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P0-3
**同批**: **E2 必须与本 ticket 同批** —— 本 ticket 让 run「更能活」，E2 提供刹车
**被阻塞**: 无
**设计文档**: §5.3

---

## 问题

`classifyRecoverability`（`retry-queue.ts:22-72`）用**关键词子串匹配**判可恢复性，**未知一律不可恢复**（`:70-71`）。

真实世界的 `rate limit`、`overloaded`、`529`、`ECONNRESET`、`socket hang up` 全部落入 unknown → 直接 `blocked`。**过夜跑遭遇一次限流即永久死亡。**

双向误伤：含 `token` 字样的错误串（如 tokenizer 报错）误判不可恢复（`:60`）；含 `timeout` 字样的路径/消息误判可恢复（`:29`）。

## 做什么

改为**显式分类表**（借 oh-my-claudecode 的集中式豁免清单形态）：

| 类别 | 判据 | 处置 |
|---|---|---|
| 限流 | HTTP 429、`rate limit`、`Retry-After` 存在 | 可恢复 + **独立长退避档**（尊重 `Retry-After`） |
| 服务过载 | 529、`overloaded` | 可恢复 + 长退避 |
| 网络瞬时 | `ECONNRESET`、`ETIMEDOUT`（网络层）、`socket hang up`、`EPIPE` | 可恢复 |
| 认证 | 401、403 | 不可恢复（需人工） |
| 上下文超限 | `context_length_exceeded`、`max_tokens` | 可恢复**一次**（触发压缩后重试） |
| 权限 | `permission` | 不可恢复（保持现状） |
| 未知 | 其余 | **仍保守判不可恢复**，但记录原始错误串供诊断 |

### 关键约束

- 判据优先用**结构化字段**（HTTP status、error code），不用消息子串；
- 只在 host 只给字符串时退化为匹配，且**必须锚定**（`/^ETIMEDOUT\b/` 而非 `includes('timeout')`）——这是消除双向误伤的关键；
- 同步扩大 `RESUMABLE_BLOCKED_REASONS` 覆盖瞬时错误致死的情形。⚠️ **但该集合当前是死逻辑**（四个成员全无生产写点 + RPC 不查它），**必须配合 E4 才真正生效**。

### 顺带

- 分级重试指导：`buildRetryInstruction` 按 `retry.attempt` 分档——前几次「修复后重试」，达阈值改口「换完全不同的方法或停下汇报」；
- 相同失败检测：失败描述归一化（去时间戳/行号）后连续 N 次相同 → 不再退避，转 blocked 或换策略；
- 退避加 jitter（P2-18）：`computeRetryDelay` 增 ±20% 随机，避免多 run 同步重试放大冲击。

## 验收

- [ ] 429 / 529 / `ECONNRESET` 判为可恢复并进入长退避
- [ ] 含 `token` 字样的非预算错误**不再**误判不可恢复
- [ ] 含 `timeout` 字样的路径/消息**不再**误判可恢复
- [ ] 分类基于结构化字段，字符串匹配已锚定
- [ ] 退避有 jitter
- [ ] 与 E2 同批上线（无刹车不得上线）
