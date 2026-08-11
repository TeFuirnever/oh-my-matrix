# 05 — Ledger-output backstop on 完成判定

**What to build:** 完成判定（模型措辞正则命中）要求最近台账有实际产出（改过文件/跑过命令）才信——防"嘴上说完成但啥也没干"。

**Blocked by:** 02 — Evidence-coupled 记账（产出语义与"验证才算 progress"一致后，backstop 判定才稳）

**Status:** ready-for-agent

- [ ] `isTaskComplete` 命中但最近台账无实际产出 → 不判完成（继续/revise）
- [ ] 有产出才信完成措辞
- [ ] 契约测试：空产出完成声明被拦
