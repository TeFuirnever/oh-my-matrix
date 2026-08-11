# 01 — Human gate（人类判断门）

**What to build:** run 在真决策点（free-text goal 无 ground truth 处）暂停进入"等人判"状态；人类看到具体问题（approve/reject/defer）；判定后 run 恢复。业界渐进自治定位——只在真决策点 gate，不过度阻塞。

决策形状（来自设计文档 Part C，schema 决策）：

```
waiting_human blocked reason（resumable）
humanQuestion 投影字段（具体问题 + 选项）
human_gate_decided OrchestratorEvent（approve/reject/defer → 恢复/blocked）
resume contract：只 rebase 决策点，不回滚工作树
```

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 暂停态 `waiting_human` 可恢复（进入 RESUMABLE allowlist）
- [ ] `humanQuestion` 投影透出具体问题与选项（非"等 owner"空话）
- [ ] 判定事件恢复 run（approve→继续 / reject→terminal / defer→保持暂停）
- [ ] resume 尊重决策点（不回滚已完成工作）
- [ ] 阻塞式（approval）而非通知式；超时行为明确
- [ ] 契约测试：三判定各得正确终态
