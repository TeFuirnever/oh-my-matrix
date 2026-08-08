# M5 — 存活指示：托盘 tooltip

**仓**: MatrixAssistant（主进程）
**缺口**: P1-12 的部分替代
**阻塞**: 无（但数据源在 M1 的驱动器里，建议 M1 之后做）
**设计文档**: §5.14、§8.1

---

## 为什么保留这一条

面板撤销后，26 个暗字段绝大多数可由「异常时提醒」覆盖。**唯独一个不行：「它还活着吗」。**

这是**主动查询型**问题（用户想看时去看），提醒是被动推送，覆盖不了。长跑场景下这是第一位的问题——优先于成本、优先于验证状态。

出口不必是界面。托盘现成：`updateTrayStatus(status: string)`（`electron/main/tray.ts:190`），且驱动器就在主进程（M1），数据不用跨进程搬。

## 做什么

- 悬停可见：运行状态 + `N/M` 轮次 + 距上次活动时长（`lastActivityAt`）；
- 无活跃 run 时恢复默认 tooltip（`tray.setToolTip(t('tray.tooltip'))`，`tray.ts:176`）；
- 多 run 并发显示聚合（如「Autopilot · 2 个运行中」），**不逐个展开**——tooltip 不是列表。

⚠️ **不要引入定时器专门刷新**。搭 M1 驱动器已有的 `sessions.changed` 处理即可。tooltip 停在「3 分钟前活动」本身就是有效信息——**它不动 = 引擎没事件 = 可能真卡了**。伪造的实时跳动反而掩盖问题。

## 明确不做

**托盘菜单不加 autopilot 操作项**（stop/resume 留在 `ContinuousModeToggle`）。加了就是把面板搬进托盘，违背范围决策。

## 配套：异常提醒

M1 的主进程驱动器照 `electron/utils/todo-executor.ts:485` 的 `notifyRenderer` 形状，在**停滞 / 终止 / 预算触顶**时推消息给渲染层弹 toast。

⚠️ `todo-executor.ts:474-479` 的去重窗口**一并照抄**——长跑异常容易连续触发，不去重会刷屏。

## 验收

- [ ] 有活跃 run 时 tooltip 显示状态 + 轮次 + 距上次活动时长
- [ ] 无活跃 run 时恢复默认 tooltip
- [ ] 多 run 显示聚合而非列表
- [ ] 无专用定时器
- [ ] 异常提醒有去重窗口
- [ ] 托盘菜单无 autopilot 操作项
