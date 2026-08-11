# 07 — Successor chaining / openItems 用起来

**What to build:** 每轮结束时模型声明下一步/未完成项——填充台账里恒空的 `openItems` 字段。"done 必答下一步"是最轻量的拆解痕迹（执行时追踪，非规划阶段，不撞"无规划阶段"决策）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 每轮台账记录 openItems（模型声明的未完成项/下一步）
- [ ] openItems 注入续轮指令（模型可见）
- [ ] 完成时要求 openItems 为空（或有明确收尾声明）——"done 必答下一步"的收尾形态
- [ ] 契约测试：openItems 填充/注入/完成约束
