# 07 — MA 宿主 canResume 按钮切换

**What to build:** 宿主 resume 按钮显示条件从 `isPaused` 改为 `canResume`（projection 已透出）——不可恢复 blocked（tool_error_repeated/token_budget_exceeded 等）不再显示永远点不动的按钮。

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] 宿主 UI 按钮条件切换 isPaused → canResume
- [ ] 不可恢复 blocked run 显示正确状态（非"可恢复"误导）
- [ ] 回归：可恢复 blocked（evidence_missing/no_progress）按钮可用

## 参考
autopilot-verification-floor-design.md §3.3/§5.12 必做 1（同批要求）；review finding（死按钮状态）。
