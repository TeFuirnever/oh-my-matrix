# Dynamic Workflows 产品化计划对抗 Review 报告

- **日期**:2026-07-01
- **对象**:`@oh-my-matrix/dynamic-workflows` 能力边界、产品化计划、Claude Code / 业界最佳实践对齐
- **范围**:计划审计与架构边界修正;不包含 runtime 代码实现
- **结论一句话**:原先的 controller-first 产品化计划应判 **BLOCK**。Dynamic Workflows 的底层能力并不只是“检视问题”,但当前产品表面偏窄;正确下一步不是把 `packages/dynamic-workflows/` 扩成中央 controller,而是先冻结边界、补 ADR、恢复测试基线,再实现 host/UI 可观测性投影契约。

---

## 1. 执行摘要

当前仓库里 Dynamic Workflows 实际由四层组成:

| 层 | 当前职责 | 证据 |
|---|---|---|
| Skill | 教 agent 生成 `.prose` 并通过 OpenProse 执行 | `packages/dynamic-workflows/skill/SKILL.md` |
| OpenProse | 编译、执行、保存 workflow 状态 | ADR-009 |
| Guard plugin | 只保护 `:subagent:` 的危险工具调用 | `packages/dynamic-workflows/index.ts`、ADR-012 |
| Host/UI projection | 显示进度、分支、blocked call、证据状态 | `docs/roadmap.md` P3,尚未实现 |

所以能力判断要分开看:

- **底层编排能力不小**:ADR-009 已确认 OpenProse 覆盖 fan-out、pipeline、adversarial verify、loop、routing、tournament、generate-and-filter、duel-loop 等模式。
- **当前产品体验偏小**:用户可感知的入口主要是 skill 文档与 guard 安全能力;缺少稳定的“为什么启用 workflow / 当前跑到哪里 / 哪些分支失败或被拦 / 最终证据状态”的投影。
- **原 controller-first 计划过宽**:它把 skill 分类、OpenProse runtime、guard hook、host projection 混成一个控制面,容易重走“自建 runtime”的旧路,也会违反 ADR-009 的核心决策。

本报告建议采用 **boundary-first productization**:先明确边界与数据源,再做投影契约和 host 可视化,最后才评估是否需要新的 tool/hook。

---

## 2. Review Team Verdict

| 角色 | Verdict | 核心意见 |
|---|---|---|
| Architect | **BLOCK** | controller-first 计划混淆了四层边界;需要先写 ADR/design,不能直接改 guard package。 |
| Critic | **BLOCK** | “workflow classification result” 不属于 runtime guard;run summary 必须从真实 OpenProse 状态和 guard audit 推导。 |
| Test Engineer | APPROVE_WITH_CHANGES | 先修测试基线和挂起问题;再按 layer 写测试,避免假事件形状或假状态。 |
| Researcher | APPROVE_WITH_CHANGES | Claude Code 最佳实践偏向 script/runtime 分离、subagents 隔离、hooks 做确定性 enforcement,不支持把 hooks 做成策略 controller。 |
| Planner | APPROVE_WITH_CHANGES | 可继续,但第一阶段应改成报告 + ADR + 测试基线,不是实现 controller。 |

**综合判定**:BLOCK 原计划,批准修正版路线。

---

## 3. 主要 Blockers

### B1: controller-first 违反现有 ADR 边界

ADR-009 的核心结论是“不要自建 custom JS runtime,使用 OpenProse”。如果把 `@oh-my-matrix/dynamic-workflows` 扩成 workflow controller,很容易让 guard plugin 承担 runtime / scheduler / strategy 职责。

**修正**:保留 OpenProse 为 runtime。`dynamic-workflows` package 的 runtime 部分继续只做 subagent guard;产品化能力放在 projection contract 和 host/UI 层。

### B2: `workflow classification result` 放错层

“这个任务为什么需要 dynamic workflow”是 agent/skill/host 决策,不是 `before_tool_call` guard 能可靠判断的事实。guard 只看到工具调用,看不到完整意图、计划质量和 workflow 选择理由。

**修正**:classification 应由 skill/host 生成并记录为 workflow metadata;guard 只能提供 blocked-call 证据。

### B3: run summary 没有真实数据源映射

原计划提出 run summary,但未说明数据从哪里来。如果直接发明状态字段,会造成“看起来完整、实际不可验证”的产品表面。

**修正**:summary 只能从两类真实来源推导:

- OpenProse run state:workflow、branch、artifact、phase、失败状态。
- Guard audit:blocked tool call、reason、cwd、command class。

### B4: hooks 不应变成策略层

Claude Code / agentic tooling 的可迁移原则是:hooks 适合 deterministic enforcement、audit、formatting、notification,不适合承载开放式规划策略。把 strategy 放进 hook 会让行为难测试、难解释、难恢复。

**修正**:hooks 只做 enforcement/audit/lifecycle。选择 workflow、解释 workflow、综合证据应在 skill / host / synthesis 层完成。

### B5: 测试基线入口曾不可信

此前验证时,`@oh-my-matrix/dynamic-workflows` 的 `pnpm` / `vitest` / `typecheck` 命令出现长时间无输出并被中断。这个问题会阻塞 TDD 和后续交付验证。

**复测结果(2026-07-01)**:问题定位到 PATH 上的用户级 `/Users/guanxueliang/.local/bin/pnpm` 入口;连 `pnpm --version` 都 30 秒无输出。使用仓库声明的 Corepack pnpm 可恢复验证:`corepack pnpm --version` 返回 `10.24.0`,`corepack pnpm --filter @oh-my-matrix/dynamic-workflows typecheck` 通过,`corepack pnpm --filter @oh-my-matrix/dynamic-workflows test` 通过 3 文件 / 26 tests。

**修正**:后续仓库验证先使用 `corepack pnpm ...`;另开独立环境修复用户级 pnpm symlink/安装,不要把 PATH 入口问题误判为 vitest 或 dynamic-workflows 问题。

---

## 4. 修正版架构方向

### 4.1 保留现有职责边界

| Surface | 应做 | 不应做 |
|---|---|---|
| `packages/dynamic-workflows/skill/SKILL.md` | 生成 `.prose`;说明何时使用 workflow;写入 workflow metadata | 不做 runtime guard |
| OpenProse | 编译、执行、恢复、保存 run state | 不被 omm 重新实现 |
| `packages/dynamic-workflows/index.ts` | 对 `:subagent:` 工具调用 fail-closed;写 audit | 不做 workflow controller / scheduler / classifier |
| Host/UI projection | 读取 run state + audit;展示分支、blocked calls、证据状态 | 不伪造 runtime 状态 |

### 4.2 新增最小 projection contract

建议先定义稳定只读投影,字段来自真实数据源:

```ts
interface DynamicWorkflowProjection {
  workflowId: string;
  phase: 'planned' | 'running' | 'blocked' | 'completed' | 'failed';
  agentCount: number;
  elapsedMs: number;
  branchStates: Array<{
    id: string;
    name?: string;
    phase: 'pending' | 'running' | 'blocked' | 'completed' | 'failed';
    summary?: string;
    artifacts?: string[];
  }>;
  blockedCalls: Array<{
    at: number;
    branchId?: string;
    toolName: string;
    reason: string;
    cwd?: string;
  }>;
  artifacts: string[];
  summaryStatus: 'verified' | 'partial' | 'blocked' | 'uncertain';
}
```

暂缓字段:

- `costEstimate`:没有可靠 token/cost 数据源前不加。
- `confidenceScore`:除非有可追溯 evaluator 证据,否则容易制造伪确定性。
- `recommendedNextAction`:先由 final synthesis 文本表达,不要过早固化成 schema。

### 4.3 ADR-014 需要记录的决策

新增 `docs/adr/014-dynamic-workflows-product-boundary.md`,建议记录:

1. Dynamic Workflows 产品化不改变 ADR-009:OpenProse 仍是 runtime。
2. `@oh-my-matrix/dynamic-workflows` runtime plugin 仍是 guard,不是 controller。
3. 产品能力通过 projection contract 和 host/UI 展示补齐。
4. classification metadata 属于 skill/host 层。
5. blocked-call evidence 来自 permission-policy audit。
6. hooks 只能承担确定性 enforcement/audit/lifecycle。

---

## 5. 实施里程碑

### Milestone A: 决策与报告

- [x] 输出本审计报告。
- [x] 新增 ADR-014,冻结产品边界。
- [x] 在 `docs/roadmap.md` P3 下补 projection contract 的交付口径。
- [x] 新增 Dynamic Workflows projection 设计文档。
- [x] 新增 projection fixture capture spec,防止后续实现使用虚构 fixture shape。

### Milestone B: 测试基线恢复

- [x] 复现 `pnpm --version` 挂起,确认问题早于 vitest/tsc。
- [x] 缩小到 PATH 上的用户级 pnpm 入口问题;Corepack pnpm 可用。
- [x] 形成稳定验证命令:`corepack pnpm --filter @oh-my-matrix/dynamic-workflows typecheck` + `corepack pnpm --filter @oh-my-matrix/dynamic-workflows test`。

### Milestone C: Projection Contract

- [ ] 用 fixture 表达 OpenProse run state + guard audit 的输入。
- [ ] 添加 projection 单元测试:branch state、blocked call、summaryStatus 推导。
- [ ] 实现只读 projection builder,不改 guard 行为。

### Milestone D: Host/UI 集成

- [ ] host 渲染 `.prose` execution progress。
- [ ] 展示 branch outputs、blocked calls、final synthesis status。
- [ ] 增加 deployed-dist smoke check,避免 source 通过但 host 未更新。

---

## 6. 验证策略

### Layer tests

| 层 | 测试重点 |
|---|---|
| Skill/golden | 何时启用 workflow、生成 `.prose`、direct fallback 限制 |
| Guard plugin | 只测 `:subagent:` safety、priority、audit,不测 workflow strategy |
| Projection | 从 OpenProse run fixture + guard audit 推导 UI 状态 |
| Host smoke | 确认 dist 部署后 host 能读取 projection 并渲染 blocked calls |

### Regression gates

最小门禁建议:

```sh
corepack pnpm --filter @oh-my-matrix/dynamic-workflows typecheck
corepack pnpm --filter @oh-my-matrix/dynamic-workflows test
corepack pnpm --filter @oh-my-matrix/permission-policy test
```

如果改到 host distribution 或 runtime guard,还需要执行内部 host-deploy 和 deployed-dist smoke check。仓库文档已经明确:不能仅凭 source 通过就宣称 consuming OpenClaw host 已生效。

---

## 7. 推荐的下一步

按优先级执行:

1. **写 ADR-014**:先冻结边界,防止后续实现把 guard 扩成 controller。
2. **定义 projection fixture 和 contract**:先用真实数据源证明字段可推导。
3. **实现 projection builder**:只读、可测试、无 runtime 行为变更。
4. **再做 host/UI 展示**:把“能力很强但不可见”的问题变成可观察产品体验。
5. **独立修复用户级 pnpm 入口**:这不是 dynamic-workflows 包内问题,不应阻塞 projection 设计。

不建议下一步做:

- 不建议直接实现 `workflow controller`。
- 不建议把 `before_tool_call` hook 变成 planner。
- 不建议在没有真实数据源时承诺 cost、confidence、recommendation 字段。
- 不建议在测试挂起未解决前改 runtime guard。

---

## 8. 最终建议

Dynamic Workflows 的“能力范围太小”不是底层编排能力问题,而是产品表面和可观测性问题。最佳实践路线是:

> **先报告,后 ADR,确认测试基线,最后实现 projection/observability。**

这条路线保留 OpenProse 的 runtime 优势,保留 guard plugin 的安全边界,同时补上用户真正缺的 workflow 可解释性、可恢复性和可观察性。
