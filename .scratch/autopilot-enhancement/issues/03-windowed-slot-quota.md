# 03 — Windowed slot quota（E2 硬上限落地）

**What to build:** E2 token 硬上限卡在 host telemetry 不可靠——改用插件可数单位（continuations）做窗口配额：窗口内超限 → throttle（可恢复，非 terminal），窗口滚动自动恢复；证据失败的轮退款。staged：advisory → downgrade（接现有思考强度降级）→ hard。

决策形状（来自设计文档 Part C）：`maxContinuationsPerWindow` + 证据失败退款 + throttle（resumable）。

**Blocked by:** 02 — Evidence-coupled 记账（退款依赖"证据失败"判定）

**Status:** ready-for-agent

- [ ] 窗口内 continuation 计数（非 token——免疫 host telemetry 缺失）
- [ ] 超限 → throttle（resumable，非 terminal pause）
- [ ] 窗口滚动自动恢复资格
- [ ] 证据失败轮退款（不烧配额）
- [ ] staged：advisory → downgrade → hard（可配）
- [ ] 契约测试：窗口/退款/滚动恢复
