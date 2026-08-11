# 09 — exact-head cursor（防伪造进度）

**What to build:** agent_end evidence 去重——"已处理"声明必须投影自先前记录（键 `NUMBER@HEAD_OID` 式精确头游标），硬拒未投影的伪造声明。防 agent 声称未分配的工作/重复 evidence。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] evidence 记录带精确头键（内容/状态标识）
- [ ] "已处理"声明须投影自先前候选（否则拒绝）
- [ ] 重复 agent_end evidence 去重
- [ ] 契约测试：伪造"已处理"被拒
