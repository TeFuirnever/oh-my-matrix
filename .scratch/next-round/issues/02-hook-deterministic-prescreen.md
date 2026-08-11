# 02 — hook 确定性预筛（agent_turn_prepare 任务特征 → fan-out 指引注入）

**What to build:** 动态 workflow 在通用场景的确定性触发层——插件注册 `agent_turn_prepare` hook，读 `event.prompt`（用户原始任务），按任务特征规则（涉及文件数信号 / 词数规模 / 信号词：并行、多视角、审计、迁移、重构、多文件）判定，命中则返回 `{ appendContext: fan-out 指引 }` 注入 agent——弱模型不再依赖自判。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 插件注册 `agent_turn_prepare`（复用现有 on/registerHook 封装）
- [ ] 任务特征规则：文件数 / 词数阈值 / 信号词（对齐 research 三测试：独立性 + 规模 + 自然并行）
- [ ] 命中 → `appendContext` 注入指引；小任务零开销（不注入）
- [ ] 与 autopilot 的 agent_turn_prepare 共存（priority 协调）
- [ ] 单元测试：命中/不命中/边界（小任务抑制）

## 参考
通道已确认可行（openclaw PluginAgentTurnPrepareEvent.prompt + appendContext，autopilot index.ts:951 同通道先例）；研究结论：hook 是唯一确定性触发杠杆。
