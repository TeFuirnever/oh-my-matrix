# 06 — MA 旧角色 overlay 残留清理

**What to build:** MA 宿主 resources/skills/default/dynamic-workflows/references/role-prompts/ 里被删除的 8 个旧角色文件（explorer/implementer/judge/reviewer/security-auditor/skeptic/synthesizer/test-author）是 overlay sync 残留——删除，防模型误用旧角色名。

**Blocked by:** 05（升级后一起处理）

**Status:** ready-for-agent

- [ ] 宿主 role-prompts 目录 = 19 个新角色（8 个旧文件删除）
- [ ] 用户侧 ~/.openclaw/skills/ 拷贝同步（init-skills 或手动）
