# 05 — AC-NNN 谓词格式（选做）

**What to build:** goal 从 free-text 升级为可携带结构化验收标准（AC）的形态——每条 AC 含场景/动作/期望/禁止副作用/验证方法/优先级。验证方法可映射到既有验证命令，让 evidence 门有物可判（而非仅"命令 exit 0"）。向后兼容纯文本 goal。

**Blocked by:** 02 — 验收基线落地后，AC 谓词才有判定依托

**Status:** ready-for-agent

- [ ] goal 可携带 AC 列表（向后兼容 free-text）
- [ ] 每条 AC 含验证方法字段，可映射到验证命令
- [ ] 带 AC 的 goal 在证据门判定时可对照 AC（至少可展示/可追踪）
- [ ] 文档更新：goal 格式说明
