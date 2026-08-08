# E4 — `skipped ≠ passed` + resume 守门修正

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P0-4（完成判定退化为正则）+ P1-8（resume 绕过守门 ⊕ 可恢复集全不可达）
**被阻塞**: **T0**
**同批**: **M2 必须与本 ticket 同批**（跨仓）—— 见下方警告
**设计文档**: §5.4

---

## 三步必须同做

v1 的方案依赖「`evidence_missing` 在 resumable 集里，用户可一键 resume」。**该前提不成立**——集合四个成员在生产**全部不可达**，且 RPC 的 resume 根本不查该集合。故必须三步同做，否则承诺的体验不存在。

### 第一步：区分 `skipped` 的两种成因

| 成因 | 处置 | 理由 |
|---|---|---|
| **从未配置**验证命令（`commands.length === 0`） | `done` + `completionUnverified: true`（**行为不变**，仅加标记） | 无测试项目是合法场景，不该被拦 |
| **配置了但没跑成**（命令缺失/超时/被 allowlist 丢弃） | `blocked` + `blockedReason = 'evidence_missing'` + `completionUnverified: true` | 「本应验证却没验证」才是真风险 |

实施点 `orchestrator.ts:261` 的 `evidence_finished` 分支。

⚠️ **不要匹配 `failureReason` 字符串**——当前 `evaluateEvidence`（`evidence-gate.ts:27-35`）对「无命令」返回 `skipped` 并附 `'no validation commands configured'`。应新增**显式字段**（如 `skipReason: 'not_configured' | 'not_executed'`）。

⚠️ `index.ts:619` 的 fail-open 分支也产出 `skipped` + `'evaluation error'`——它属「配置了但没跑成」，归 blocked 一侧。

### 第二步：让 `evidence_missing` 真正可达

上表第二行是该 blockedReason 的**首个生产写点**。验证 `VALID_BLOCKED_REASONS`（已含）与恢复 allowlist（`state-persister.ts:432`，已含）无需改动。

### 第三步：让 resume 尊重守门

`autopilot.resume`（`index.ts:1318-1335`）必须在 reducer no-op 时**停止**，而非继续调 setter：

```ts
const orchestrated = orchestratorReducer(state, { type: 'resume_requested', runId, now });
if (orchestrated === state) {                       // reducer 拒绝了
  respond(false, undefined, { code: 'INVALID_REQUEST',
    message: `cannot resume: ${state.blockedReason} is not recoverable` });
  return;
}
```

`resume()` setter 职责收缩为「清理副状态」（`toolErrorCount`、`lastToolError`、`degraded`），**不再自行写 `orchestrationState`/`blockedReason`**——那是 reducer 的职责（ADR-016）。同时清 `retry`，否则「假性康复」仍在（resume 后下一次失败立即再 blocked）。

## ⚠️ 行为破坏性：必须与 M2 跨仓同批

这是本轮**唯一减少用户可用操作**的变更。

**单独上线 E4 会让 resume 按钮变成永远点不动的死按钮**——按钮显示条件只是 `isPaused`（MA `ContinuousModeToggle.tsx:168`），而 `deriveStatus` 把不可恢复的 blocked 也派生成 `paused`（`orchestrator.ts:60`）。用户点了 → 拒绝 → 泛化 toast → run 不动。**比现状更糟。**

M2 只改一行（`isPaused` → `canResume`），但不能省、不能晚。

## 投影字段

`src/projection.ts` 透出 `completionUnverified` 与 `canResume`（由 `RESUMABLE_BLOCKED_REASONS.has(blockedReason)` 计算）。

⚠️ `canResume` 的**唯一消费点是 M2**。不做 M2 则该字段新增即成死字段。`completionUnverified` 在面板撤销后无渲染消费点，仅供 M5 托盘摘要与将来使用。

## 现有测试影响

以下断言「无命令 → skipped → done」，本方案**保持该行为不变**故不会被打断，但 `completionUnverified` 新字段需同步预期：

- `tests/evidence-wiring.test.ts:86-93`、`:96-103`
- `tests/orchestrator.test.ts:594-603`
- `tests/e2e/lifecycle.e2e.test.ts:150`

第三步会打断任何断言「非可恢复 blocked 也能 resume」的测试——实施时 grep `autopilot.resume` 的测试覆盖。

## 验收

- [ ] 「从未配置」保持 done，仅加 `completionUnverified` 标记
- [ ] 「配置了没跑成」转 blocked + `evidence_missing`
- [ ] `skipReason` 是显式字段，非字符串匹配
- [ ] 非可恢复 blocked 的 resume 被 RPC 明确拒绝（不是 no-op 静默）
- [ ] `resume()` 不再写 `orchestrationState`/`blockedReason`（ADR-016）
- [ ] resume 清 `retry`，无假性康复
- [ ] **与 M2 同批上线**
- [ ] CHANGELOG 标 minor 并显著说明
