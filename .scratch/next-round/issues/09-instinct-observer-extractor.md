# 09 — instinct：context 记忆 observer + extractor（第三缺口）

**What to build:** 新包 `@oh-my-matrix/instinct` 闭合 context 记忆真空——observer 捕获 tool/input/output → observations.jsonl（rotation/purge/secret scrub）；turn-boundary extractor 提取 instinct（confidence/domain/scope）。promote/evolve YAGNI until ≥3 projects。

**Blocked by:** None（前置：≥3 项目实况）

**Status:** ready-for-agent

- [ ] observer（复用 permission-policy audit-persister JSONL+rotation）
- [ ] extractor（before_agent_finalize/agent_turn_prepare 注入 appendContext 提取）
- [ ] secret scrub + 自循环守卫（isSubagentSessionKey）
- [ ] 项目检测 sha256[:12]

## 参考
ecc-intake-recommendation.md §3.1 #1（完整设计含 graft 点）；ponytail：observer(S)+extractor(M) 先行。
