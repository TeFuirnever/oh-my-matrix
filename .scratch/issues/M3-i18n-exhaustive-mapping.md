# M3 — `PauseReason`/`BlockedReason` 穷举 i18n 映射

**仓**: MatrixAssistant（类型层，非 UI）
**缺口**: 跨仓契约防线
**阻塞**: 无 —— 可立即开工
**设计文档**: §5.12 必做 2

---

## 问题

当前动态拼 i18n key：

```ts
t(`autopilot.pause.${pauseReason ?? 'unknown'}`, pauseReason ?? 'paused')     // ContinuousModeToggle.tsx:125
t(`autopilot.blocked.${projection.blockedReason}`, projection.blockedReason)  // :209
```

引擎（oh-my-matrix）新增一个 reason，MA 侧**编译期完全无感**，运行时把原始 code 甩给用户——界面上直接蹦出 `max_retries_reached`。

## 做什么

改为穷举映射对象，照 `src/pages/Chat/components/autopilot-send.ts:126-130` 的 `ACTIVATE_FAILURE_I18N` 既有模式。使跨仓漏配在**类型检查/测试期**暴露，而非运行时。

## ⚠️ 三处会新增 reason，必须同步

| 来源 | 新增内容 |
|---|---|
| E2 | 两个新 `PauseReason`（墙钟上限、成本上限） |
| E4 | `evidence_missing` **首次可达**——它一直在集合定义里但从无生产写点 |
| E10 | 若派发 `workspace_failed` / `permission_denied`（那两个事件目前定义了从不派发） |

不做本 ticket 的话，上述新状态在 UI 上全部显示为裸 code。

## 验收

- [ ] `PauseReason` / `BlockedReason` 全成员有显式 i18n key 映射
- [ ] 引擎新增 reason 时**编译失败或测试失败**（这是本 ticket 的核心价值，需有测试证明）
- [ ] en / zh 两侧文案齐全
- [ ] 无运行时裸 code 泄漏路径

## 说明

本 ticket 名义上改渲染层文件，但**性质是类型层契约**，与「MA 不做 UI」的范围决策不冲突——它不新增任何界面，只让既有的两处文案渲染变成类型安全的。
