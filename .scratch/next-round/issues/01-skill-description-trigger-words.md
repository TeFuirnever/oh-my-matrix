# 01 — SKILL.md description 触发词重写

**What to build:** dynamic-workflows skill 在通用场景（开发、任务处理、多文件修改）被模型主动激活——description 增加 "use proactively" 措辞 + 开发/任务处理场景触发词（并行、多视角、大规模修改、重构、迁移、审计），提升模型自判触发率。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] SKILL.md frontmatter description 加 "use proactively" + 通用场景触发词
- [ ] 触发词与 19 角色库 Use when 对齐（不重叠、不冲突）
- [ ] test-prompts.json 负例（小任务不激活）仍通过

## 参考
研究结论（2026-08-10 deep-research）：description 是模型自判触发的唯一可靠杠杆（anthropics/skills #267：~80% 触发问题源于描述模糊）。
