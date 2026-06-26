# 设计文档：为 OpenClaw 打造 Dynamic Workflows

> 版本：v14（MA 二轮实测 + 证据驱动修复）· 日期：2026-06-26
> 审查链：3 人对抗 Claude 审查团 + Codex 两轮（含源码做实）+ v6 对抗审查 + E1-E4 技术预研 + Autopilot 实现。
> OpenClaw 源码锚点：git HEAD `e9321608`，tag/version `v2026.5.28`。

---

## 1. 目标

对标 **Claude Code dynamic workflows**：用户说自然语言 → AI 自动判断是否需要 workflow → AI 自动生成编排计划 → 运行时扇出 subagent → 中间结果不进用户上下文 → 只回最终结果。为 **OpenClaw 及衍生项目**打造等价的 AI 自主编排能力。

## 2. 路线决策（预研驱动）

### 2.1 预研结论

| 实验 | 结论 |
|------|------|
| **E1** | 纯 prompt + sessions_spawn 的 ceiling ≈ 5-8 agent，对标 Claude Code（数十~数百 agent）远不够 |
| **E2** | 🟢 **OpenProse 8/8 编排模式全覆盖**（fan-out/pipeline/adversarial/loop-until-dry/routing/tournament/generate-and-filter/duel-loop）；有递归 block、AI 条件、管道、pairwise、错误处理（try/catch/on-fail）、并行策略（race/any-N/continue/ignore）、状态后端（fs/sqlite/postgres）、compiler 校验、标准库、49 个示例；`workflow-crystallizer.prose` 已做"自然语言→.prose"。**bundled plugin，随 OpenClaw 发行。** |
| **E3** | ✅ `api.runtime.subagent`（run→waitForRun→getSessionMessages）可 await、可并发、结果提取路径确定（`role:"assistant"` 消息的 `content[type:"text"].text`） |
| **E4** | ✅ `registerTool` 可用（需 `contracts.tools` 声明）；执行阻塞 agent turn（无后台）；有 onUpdate + AbortSignal |

### 2.2 选定路线：B —— AI 生成 .prose + OpenProse 执行

**核心逻辑**：OpenProse 已实现了 v6 计划中 P2-P4 的全部运行时工作（loader/primitives/scheduler/状态/错误处理/并行/管道/递归/沙箱/安全权限/标准库）。从零建 JS 运行时 = 重复建设。

**我们只需做 OpenProse 之上的"AI 自主编排"层——教 agent 在合适时机自动生成 .prose 程序并通过 OpenProse 执行。**

### 2.3 被排除的路线

| 路线 | 排除原因 |
|------|---------|
| A（纯 prompt） | ceiling ~5-8，对标目标需数十~数百 agent |
| C（建 JS 运行时） | OpenProse 8/8 全覆盖且已 bundled，建等价 JS 运行时 = 重复建设（10x 工作量无净增价值） |

## 3. 产品形态

```
用户说自然语言（"审计所有 API 端点的鉴权"）
    ↓
OpenClaw agent 判断需要 workflow
  ├─ 触发：ultracode 关键词 / 用户显式要求 / skill 引导
  ├─ 判断：任务复杂度 × 需要并行/交叉验证 × 规模超出单 agent
  │
agent 自动生成 .prose 程序
  ├─ 参考：编排模式库（精选摘要）+ .prose 语法（compiler.md）+ 示例
  ├─ 校验：OpenProse compiler 验证 → 失败则 agent 修复（最多 3 轮）
  │
agent 调用 /prose run <generated.prose>
    ↓
OpenProse VM 执行（parallel / pipeline / loop / agent spawn / 错误处理）
    ↓
结果返回 agent → agent 对用户汇报最终答案
```

### 与 Claude Code 四层对照

| 层 | Claude Code | 我们（路线 B） | 谁提供 |
|---|---|---|---|
| 层1 触发判断 | ultracode 关键词/模式 | **SKILL.md 引导 + 触发关键词** | **oh-my-matrix（新建）** |
| 层2 AI 脚本生成 | Claude 写 JS 脚本 | **agent 写 .prose 程序**（更简单的语法 + compiler 校验） | **oh-my-matrix（新建）** |
| 层3 运行时执行 | JS 运行时（agent/parallel/pipeline） | **OpenProse VM**（parallel/pipeline/loop/递归/条件/错误处理） | **OpenProse（已有，零代码）** |
| 层4 可观测/控制 | /workflows 视图 + 暂停/停止 | **OpenProse 原有**（.prose/runs/ 目录 + 状态后端） | **OpenProse（已有）** |

**净新建 = 层1 + 层2 ≈ SKILL.md + 模式库 + 生成-验证循环。层3 + 层4 = 零。**

## 4. 架构决策

| 维度 | 决策 |
|------|------|
| 运行时 | **不建**。使用 OpenProse（bundled plugin） |
| 编排语言 | **.prose**（markdown-first DSL，比 JS 方言简单，AI 生成质量下限更高） |
| agent() 后端 | **OpenProse 的 sessions_spawn**（OpenProse 原有机制） |
| oh-my-matrix 定位 | **AI 自主编排 skill 包**（教 agent 何时/如何生成 .prose）；不是运行时 |
| 交付形态 | **SKILL.md + 模式库 + 生成-验证-修复文档**，作为 OpenClaw skill 分发 |
| 前置依赖 | OpenProse 已启用（`openclaw plugins enable open-prose`） |
| 与 autopilot 关系 | 并存互补（autopilot=连续循环；dynamic-workflows=多 agent 扇出/DAG） |

## 5. 核心交付物

### 5.1 SKILL.md（核心）
教 OpenClaw agent：
- **何时用 workflow**：任务判断准则（复杂度/并行需求/规模/交叉验证需求）
- **如何生成 .prose**：语法要点（精简版 compiler.md）+ 编排模式库（8 种模式 × 模板 + 选择指南）+ 49 个示例引用
- **生成-验证-修复循环**：agent 生成 .prose → `/prose compile` 校验 → 失败则反馈问题修复 → 最多 3 轮
- **如何运行**：`/prose run <file.prose>` 或 `/prose run <inline>`
- **触发关键词**：对标 `ultracode`

### 5.2 编排模式库（策展精选）
从 OpenProse 49 个示例 + patterns.md 中精选 8 种核心模式的**紧凑摘要**（每种 ≤10 行 .prose 范例 + 一句"何时用"），作为 SKILL.md 的内联参考：

1. **fan-out-reduce**：`parallel:` N 个 session + 合成 session
2. **pipeline**：`| filter:` → `| map:` → `| reduce:`
3. **adversarial-verify**：finder agents + refuter agents + 过滤
4. **loop-until-dry**：`block search(docs, q, depth):` 递归 + `if **gaps remain**:` 终止
5. **routing**：`if **condition**:` / `elif` / `else` 路由到不同处理
6. **tournament**：`| reduce(best, current):` 两两淘汰
7. **generate-and-filter**：生成 → `| filter:` → `| map:`
8. **duel-loop**：`block` 递归实现 implement ↔ review 循环

### 5.3 可选：保存/重用
好的 .prose 程序保存到 `.prose/` 或 `.openclaw/workflows/`；下次 `/prose run <name>` 直接运行。

## 6. 实施计划与状态

| 阶段 | 内容 | 状态 | 说明 |
|------|------|------|------|
| **P0** | 确认 MA 环境 OpenProse 可启用 + skill 可发现 + 端到端冒烟 | ✅ 完成 | 2026-06-25 验证通过：`openclaw plugins enable open-prose` 成功；skill symlinked 到 `~/.openclaw/skills/`；Gateway 重启后加载 |
| **P1** | 写 SKILL.md + 编排模式库 | ✅ 完成 | `skill/dynamic-workflows/SKILL.md`（388 行，8 种模式 + 语法指南 + 生成-验证-修复循环 + 触发关键词）|
| **P2** | 端到端验证：自然语言 → agent 生成 .prose → 执行 → 结果 | ✅ 完成 | 真实任务验证：agent 自动生成 `error_audit.prose`（3 agent fan-out + 合成），正确 .prose 语法，端到端跑通 |
| **P3** | 分发：ADR-009 + 文档 + spine 更新 | ✅ 完成 | ADR-009 + spine + CHANGELOG 0.7.0 完成；本地验证路线 A 完成（正式集成路线 B 待定） |

### P0/P2 验证结论（2026-06-25，真实任务端到端通过）

**验证方式**：本地路线 A（不改 MA 仓，可逆）

| 步骤 | 执行 | 结果 |
|------|------|------|
| S1 启用 OpenProse | `~/.openclaw/openclaw.json` 的 `plugins.allow` 加 `open-prose` | ✅ config-audit.jsonl 记录 `openclaw plugins enable open-prose` |
| S2 放进 skill | `ln -s .../oh-my-matrix/skill/dynamic-workflows ~/.openclaw/skills/dynamic-workflows` | ✅ SKILL.md 可读 |
| S3 重启 MA | Gateway PID 37263，启动时间与 config 修改时间一致 | ✅ 新 config 已生效 |
| **真实任务** | 对 TestProject 做错误处理审计 | ✅ agent 自动生成 `error_audit.prose`（27 行） |

**生成的 .prose 证据**（`/Users/guanxueliang/Desktop/Matrix/TestProject/error_audit.prose`）：
- 3 个专家 agent（`auditor-python` / `auditor-javascript` / `auditor-config`）
- 并行扇出（`let python_report = session: auditor-python` 等 3 路）
- 合成 session（context 引用 3 路结果）
- 结构化 JSON 输出约束
- 语法与 OpenProse compiler.md 一致

**结论：路线 B（AI 生成 .prose + OpenProse 执行）端到端验证通过。**

### 路线 B 正式集成（2026-06-25 完成）

已将 dynamic-workflows 集成进 MA 仓，所有用户默认拿到：

| 步骤 | 改动 | 文件 |
|------|------|------|
| 1 启用 OpenProse | `plugins.allow` 加 `"open-prose"` | `resources/openclaw-defaults.json` |
| 2 内置 skill | 复制 SKILL.md（388 行） | `resources/skills/default/dynamic-workflows/SKILL.md` |
| 3 老用户迁移 | `migrateDynamicWorkflowsSkill()`（复用 oh-my-manus 模式：每次启动检查，不存在就复制） | `electron/utils/init-skills.ts` |

TypeScript 编译通过（无新增报错）。

### 实现交付物清单（已 ship）

| 交付物 | 路径 | 状态 |
|--------|------|------|
| D1 SKILL.md（核心） | `skill/dynamic-workflows/SKILL.md` | ✅ 388 行 |
| D2 编排模式库（8 种） | 内联于 SKILL.md | ✅ |
| D3 ADR-009 | `docs/adr/009-dynamic-workflows-via-openprose.md` | ✅ |
| D4 docs 脊柱更新 | README/CONTEXT/architecture/roadmap | ✅ 4/4 |
| D5 CHANGELOG 0.7.0 | `CHANGELOG.md` | ✅ |
| 预研报告 | `.omc/specs/E{1-4}-*.md` + `route-decision.md` | ✅ 5 份 |

### 待办

无。路线 A 本地验证 + 路线 B 正式集成均已完成。

## 7. 工作量对比（最终）

| 路线 | 核心交付 | 新代码 | 时间 |
|------|---------|--------|------|
| v6 C（JS 运行时） | 30+ 项 | ~3000-5000 行 TS | 4-6 周 |
| **v8 B（AI 生成 .prose）** | **4 项** | **~200-500 行 markdown** | **3-5 天** |
| 差异 | **10x 减少** | **10x 减少** | **6x 减少** |

## 8. 风险

| 风险 | 缓解 |
|------|------|
| AI 生成 .prose 不可靠 | compiler 校验 + generate→validate→repair 循环（3 轮）+ 49 个示例作 few-shot |
| OpenProse 在 MA 未启用/不可用 | P0 首先确认；若不可用则需 MA 侧启用或贡献上游 |
| .prose 语法变更 | OpenProse 是 OpenClaw bundled plugin，版本锁定；compiler.md 为权威文档 |
| 规模上限 | OpenProse 示例含 pairwise O(n²)；真实并发受 gateway maxConcurrent 约束 |

## 9. 版本演进记录

| 版本 | 核心变化 | 状态 |
|------|---------|------|
| v1-v5 | "OpenClaw 原生 JS 脚本运行时"（各种 await-seam 争议） | 被审查推翻 |
| v6 | 视角翻转："AI 自主编排能力层"（仍建 JS 运行时） | 被 v6 审查质疑（OpenProse 替代未评估） |
| v7 | 进入技术预研（4 个实验回答路线决策） | 预研阶段 |
| v8 | 路线选定 B：AI 生成 .prose + OpenProse 执行（OpenProse 8/8 全覆盖，不重复建设） | 实现前计划 |
| v9 | 实现完成：SKILL.md + ADR-009 + spine + CHANGELOG 0.7.0 已 ship；P0/P2 待运行环境验证 | 实现态 |
| v10 | P0/P2 验证通过：OpenProse 启用 + skill 发现 + 真实任务端到端（agent 自动生成 `error_audit.prose`，3 agent fan-out + 合成） | 验证态 |
| **v11** | **路线 B 正式集成**：MA 仓 3 处改动（openclaw-defaults.json + default skill + init-skills 迁移），所有 MA 用户默认拿到 dynamic-workflows | 集成态 |
| **v12** | **Darwin 5 轮优化**：progressive disclosure 重构（575→404 行核心+208 行 references）、3 人对抗审查修复 20+ issues、组合模式示例（discover→fan-out→verify）、引用路径分组。Darwin 评分 ~61→84.4/100，HL-4 触顶。| 优化态 |
| **v13** | **MA 实测闭环 + 执行模型修正**：实测发现 agent 跳过 `prose compile`/`prose run` 直接 `sessions_spawn`；溯源 OpenProse SKILL.md 确认"You ARE the VM"——`prose run` 不是 CLI 是 skill activation。重写 Step 3-4-5 为双模式（OpenProse primary + fallback direct）；frontmatter 加 dual-mode 描述+中文触发词；重组节顺序（Pattern selection → Core patterns → Composing → Repair loop）。Darwin 评分 88.7/100，首个 full_test 轮次。 | 优化态 |
| **v14** | **MA 二轮实测 + 证据驱动修复**：4 条测试提示实测（fan-out 审计/bounded fallback/负例/破坏性 git），发现两个问题：(1) agent 发现已有 .prose 后跳过 CHECKPOINT 直接执行——根因是 OpenProse 接管后绕过 dynamic-workflows 的检查点流程；(2) 安全类问题不触发 skill——根因是 skill 加载机制对非 workflow-creation 查询不敏感。修复：新增"Reuse path"拦截段（强制展示已有 .prose 并征得确认）、扩展触发词（"并行 agent"+安全查询）、更新 test expectations 标注 skill 触发限制。复测确认：agent 不再盲目执行已有 .prose，改为展示已有结果。554 行核心。 | **当前** |

## 10. 关键参考文件

### OpenProse（路线 B 的运行时）
- `openclaw/extensions/open-prose/`：完整实现
- `skills/prose/compiler.md`：语法语法 + 校验规则
- `skills/prose/guidance/patterns.md`：设计模式
- `skills/prose/guidance/antipatterns.md`：反模式
- `skills/prose/examples/`：49 个示例（16-parallel / 19-advanced-parallel / 20-loops / 21-pipeline / 25-conditionals / 42-filter-recurse / 43-pairwise ...）
- `skills/prose/examples/46-workflow-crystallizer.prose`："自然语言→.prose"先例

### 预研报告
- `.omc/specs/E1-prompt-ceiling.md`
- `.omc/specs/E2-openprose-boundary.md`
- `.omc/specs/E3-subagent-contract.md`
- `.omc/specs/E4-registertool-model.md`
- `.omc/specs/route-decision.md`

### Claude Code 官方
- [code.claude.com/docs/en/workflows](https://code.claude.com/docs/en/workflows)
