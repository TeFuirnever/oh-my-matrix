---
'@oh-my-matrix/dynamic-workflows': minor
---

**`subagentExtraAllowTools` operator expansion lever (ADR-022 companion, #193).** New `pluginConfig` key granting extra tool names to subagent sessions despite the fail-closed default — the same operator-owned lever Codex ships as per-agent `sandbox_mode` TOML and Gemini as policy-TOML `subagent`-scoped rules. Additive only; every grant is audited as an `allow`; guard-disarming names (generic executors `exec`/`bash`/… and fence-relevant writers `write`/`edit`/`apply_patch`/…) are refused at register with an error log; `highRiskTools` wins same-name conflicts. README now documents all three `pluginConfig` keys; ADR-022 marks the lever landed. Tests 88 → 94.
