# 04 — Fingerprint-bound diff 收据

**What to build:** 验证结果绑定最终 diff——验证过的代码变了（指纹失效），旧"验证通过"收据作废，须重新验证。"旧指纹的收据不证明新 diff"。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 验证时记录代码指纹（diff 摘要）
- [ ] 后续代码变化 → 旧收据标记失效
- [ ] 完成判定要求收据指纹与最终 diff 匹配（不匹配 → 不判完成/提示 re-verify）
- [ ] 契约测试：验证后改代码 → 收据失效
