# CONTEXT.md — oh-my-matrix Domain Language

> Single-context repo. All domain vocabulary lives here.

## 方向

oh-my-matrix 为 OpenClaw 及衍生宿主提供 **autonomous agent runtime stack**。当前不是单一 Dynamic Workflows 项目，而是三模块协作：

- **Autopilot**: 长程任务连续执行。负责目标、状态、重试、stall 检测、证据门、projection 与 `WORKFLOW.md` 配置。
- **Dynamic Workflows**: 多 agent 编排。agent 根据自然语言生成 `.prose` 程序，经 OpenProse 执行 fan-out / pipeline / adversarial verification。
- **Permission Policy**: 运行时边界。为 autopilot 和 workflow subagent 共用 command classification、permission decision、audit persistence。

v0.x 的 `team` / MCP / plugin 实现已移除，设计记录保留在 [`docs/archive/`](docs/archive/)。当前活跃源码位于 [`packages/`](packages/) 与 [`packages/dynamic-workflows/skill/`](packages/dynamic-workflows/skill/)。

## 核心概念

### Autopilot

OpenClaw-native continuous execution plugin。它让一个长程任务跨 turn 继续运行，并在工具错误、stall、证据缺失、权限拒绝、token 预算等情况下进入可解释状态，而不是静默漂移。

当前源码包：[`packages/autopilot/`](packages/autopilot/)，package name 为 `@oh-my-matrix/autopilot`。

### Dynamic Workflow

AI agent 根据用户自然语言任务生成的 `.prose` 编排程序。包含 agent 定义、并行/管道/循环/条件控制流、上下文传递，经 OpenProse 执行。

适用场景：大范围审计、并行调研、跨模型/跨角色验证、候选方案筛选、递归搜索。

### .prose 程序

OpenProse 的编排 DSL。markdown-first 语法，2 空格缩进，支持 `session`、`agent`、`parallel:`、`filter/map/reduce/pmap`、`block`、AI 条件分支等。

### Dynamic Workflows skill

[`packages/dynamic-workflows/skill/SKILL.md`](packages/dynamic-workflows/skill/SKILL.md) 是给 agent 的操作手册。它规定何时使用 workflow、如何选择 8 种模式、如何验证 `.prose`、如何在 OpenProse 不可用时降级。

### OpenProse

OpenClaw bundled plugin，提供 `.prose` 编译和执行。OpenProse 执行期间，中间分支结果留在 workflow state 中，最终只把 synthesis 返回给用户上下文。

### Permission Policy

[`@oh-my-matrix/permission-policy`](packages/permission-policy/) 是共享安全原语库。它被 autopilot 和 dynamic workflows 共同消费，负责：

- command / tool classification
- permission decision
- real `before_tool_call` event extraction
- audit JSONL persistence

### Runtime Guard

[`@oh-my-matrix/dynamic-workflows`](packages/dynamic-workflows/) 注册 `before_tool_call` priority 11，对 `:subagent:` 会话 fail-closed。它不是 prompt 约束，而是 gateway hook 级别的运行时边界。

### Host Deploy

本仓库保存源码和测试。OpenClaw 这类消费方宿主加载的是打包后的 plugin dist。源码变更后必须走宿主内部部署刷新流程，不能只以仓库测试通过作为“线上已生效”的证据。

## 设计原则

- **Autopilot 是一等模块**: README、architecture、roadmap 不能再把它写成历史委托或 partial 角落项。
- **Workflows 负责并行，Autopilot 负责持续**: fan-out 与 long-running loop 是互补能力，不互相替代。
- **Permission policy 是共享平台层**: 安全边界不应复制在每个 plugin 中。
- **运行时证据优先于叙事**: 公开文档只写源码、测试和 live evidence 能支撑的能力。
- **历史不重写**: `docs/archive/` 保留旧 v0.x 设计记录，内部链接可能 stale by design。

## ADR 索引

- [ADR-009: Dynamic Workflows via OpenProse](docs/adr/009-dynamic-workflows-via-openprose.md)
- [ADR-010: Autopilot Source Hosting](docs/adr/010-autopilot-source-hosting.md)
- [ADR-011: Runtime Workflow Guard](docs/adr/011-runtime-workflow-guard.md)
- [ADR-012: Dynamic Workflows Plugin Extraction](docs/adr/012-dynamic-workflows-plugin-extraction.md)
- [ADR-013: Permission Policy Library](docs/adr/013-permission-policy-library.md)
