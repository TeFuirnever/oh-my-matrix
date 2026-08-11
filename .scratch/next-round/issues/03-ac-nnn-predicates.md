# 03 — AC-NNN 谓词（goal 结构化验收标准）

**What to build:** goal 从 free-text 升级为可携带结构化验收标准（Scenario/Action/Expected/Must-not/Verification method/Priority）——任意任务场景下证据门"有物可判"，`completionUnverified` 面缩小。向后兼容纯文本 goal。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] goal 可携带 AC 列表（向后兼容 free-text，AC 块内嵌 goal 字符串方案）
- [x] 每条 AC 含验证方法字段，可映射到验证命令
- [x] 带 AC 的 goal 在证据门判定时可对照 AC（展示/可追踪）
- [x] 文档更新：goal 格式说明

## 参考
ecc-intake-recommendation.md §3.1 #2（AC schema 已定）；autopilot-verification-floor-design.md T05。
