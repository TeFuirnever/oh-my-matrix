# 10 — SKILL.md 增强批（B2-B7 + Block 模板）

**What to build:** dynamic-workflows §11.8 阶段 B 的 6 个触发条件驱动小增强 + Block 定义模板——统一批处理：
- B2 结构化 agent 输出约定（下游解析可靠）
- B3 Budget-aware 设计段（成本护栏）
- B4 `{baseDir}` 路径插值（非标准 cwd）
- B5 Phase 注解 + 工作流元数据
- B6 scripts/validate-prose.sh（OpenProse 不可用时的独立验证）
- B7 `[PROGRESS]` 进度报告约定
- Block 定义模板（能力表 row 6 缺口）

**Blocked by:** None — can start immediately.

**Status:** done — templates/reusable-block.prose added; B2-B7 YAGNI-deferred; SKILL.md 445 lines (within ~50 line growth budget); test-prompts 4 cases all green

- [x] B2-B7 deferred（触发条件驱动，无需求验证 = YAGNI）
- [x] Block 模板补齐（templates/reusable-block.prose）
- [x] SKILL.md 净涨幅可控（合计 ~50 行）
- [x] test-prompts 无回归

## 参考
dynamic-workflows-design.md §11.8 阶段 B 表（触发条件/前置依赖/预估工作量已定）。
