# CONTEXT.md — oh-my-matrix Domain Language

> Single-context repo. All domain vocabulary lives here.

> **方向更新 (0.7.0)** — `team` 编排方向已被 **Dynamic Workflows** 取代（[ADR-009](docs/adr/009-dynamic-workflows-via-openprose.md)）。v0.x 实现已移除，见 [`docs/archive/`](docs/archive/)。

## 方向

oh-my-matrix 为 OpenClaw 及衍生项目提供 **AI 自主多 agent 编排能力（Dynamic Workflows）**：

- **AI 自动生成 `.prose` 编排程序** —— agent 根据自然语言任务，选择合适的编排模式（fan-out/pipeline/adversarial-verify/tournament 等 8 种），生成 `.prose` 程序。
- **OpenProse 执行** —— `.prose` 程序经 OpenProse（OpenClaw bundled plugin）执行，扇出 subagent，中间结果不进用户上下文，只回最终结果。
- **Skill 包交付** —— 核心交付物是 `skill/dynamic-workflows/SKILL.md`，教 agent 何时/如何编排。运行时由 OpenProse 提供。
- **与 autopilot 并存互补** —— autopilot=连续自主循环；dynamic-workflows=多 agent 扇出/DAG/交叉验证。
- **纯插件形态** —— 无独立 CLI、无原生模块；通过 OpenClaw 插件 API 或 MCP 消费。

## 核心概念

### Dynamic Workflow

AI agent 根据用户自然语言任务自动生成的 `.prose` 编排程序。包含 agent 定义、并行/管道/循环/条件控制流、上下文传递，经 OpenProse 执行。对标 Claude Code dynamic workflows。

### .prose 程序

OpenProse 的编排 DSL。markdown-first 语法，2 空格缩进，支持 `session`（工作单元）、`agent`（角色定义）、`parallel:`（并行）、`| filter/map/reduce/pmap`（管道）、`block`（可复用子程序）、`if **AI condition**:`（AI 条件分支）。

### 编排模式

8 种核心模式：fan-out-reduce / pipeline / adversarial-verify / loop-until-dry / routing / tournament / generate-and-filter / duel-loop。大多数任务匹配一种或两种的组合。

### Skill

SKILL.md 文件，由 OpenClaw 的 AgentSkills 系统消费。omm 当前交付 `dynamic-workflows` skill（AI 自主生成 .prose 多 agent 编排）。

### OpenProse

OpenClaw bundled plugin，提供 .prose 的编译（`prose compile`）和执行（`prose run`）。agent 激活 OpenProse skill 后成为 VM：每个 `session` 语句映射到 `sessions_spawn`，`parallel:` 块并发执行，状态持久化到 `.prose/runs/`。

## 设计原则

- **ADR-009（Dynamic Workflows via OpenProse）**：不自建运行时；教 agent 生成 .prose，由 OpenProse 执行。见 [`docs/adr/009-dynamic-workflows-via-openprose.md`](docs/adr/009-dynamic-workflows-via-openprose.md)。
- **ADR-002 / ADR-008（委托哲学）**：团队并行与自主循环交给宿主。保留在 [`docs/adr/`](docs/adr/) 作为历史脊柱。
- 历史实现型 ADR 归档于 [`docs/archive/adr/`](docs/archive/adr/)。
