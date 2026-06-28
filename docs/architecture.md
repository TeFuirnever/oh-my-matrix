# omm Architecture Overview

> 🔄 **方向更新 (0.7.0)** — v0.x 的 `team` 编排实现已移除（见 [`archive/`](archive/)）。当前方向：**Dynamic Workflows**——对标 Claude Code dynamic workflows，通过 AI 自动生成 `.prose` 编排程序并经 OpenProse 执行，实现多 agent 自主编排。见 [ADR-009](adr/009-dynamic-workflows-via-openprose.md) 与 [设计文档](design/dynamic-workflows-design.md)。

## Project Positioning

oh-my-matrix (omm) 为 OpenClaw 及衍生项目提供 **AI 自主多 agent 编排能力（Dynamic Workflows）**。AI agent 根据用户的自然语言任务，自动生成 `.prose` 编排程序（含并行扇出、对抗验证、管道处理、迭代搜索等模式），经 OpenProse（OpenClaw bundled plugin）执行，扇出数十到数百个 subagent，只回最终结果。

核心交付物是一个 **SKILL.md 包**（`skill/dynamic-workflows/`），教 agent 何时/如何生成 `.prose` 工作流。运行时由 OpenProse 提供——不重复建设。

| 维度 | oh-my-codex | omm |
|------|-------------|-----|
| 运行形态 | 独立 CLI (`omx`) | OpenClaw 插件，由 Gateway 加载 |
| 团队并行 | 自建 tmux + git worktree | 委托宿主 team 原语 |
| MCP 实现 | `@modelcontextprotocol/sdk` | 手写 JSON-RPC（零依赖） |
| 分发 | npm binary + 4 个 Rust crate | 单一 tarball，纯 JS |

设计依据见 [ADR-002](adr/002-team-delegation-to-host.md)、[ADR-008](adr/008-delegation-to-host.md)（委托哲学，脊柱保留）。

## 核心架构概念

### 纯插件，无 CLI

omm 通过 OpenClaw Plugin ABI 暴露**可选工具**（`optional: true`）与**生命周期 hooks**。宿主在没有 omm 时仍正常工作——omm 是增强，不是依赖。（历史依据：[`archive/adr/001-pure-plugin-no-cli.md`](archive/adr/001-pure-plugin-no-cli.md)。）

### 单一工作流模式：`team`

`dynamic-workflows` skill 教 agent 生成包含以下生命周期的 `.prose` 程序，经 OpenProse 执行：

```
parallel agents → pipeline stages → conditional routing → synthesis → result
```

OpenProse 支持 `parallel:` 真并行（含 race/any-N/on-fail 策略）、`for`/`repeat`/`block` 递归循环、`if **AI condition**:` 条件分支、`| filter/map/reduce/pmap` 管道、`try/catch` 错误处理。8 种编排模式（fan-out-reduce / pipeline / adversarial-verify / loop-until-dry / routing / tournament / generate-and-filter / duel-loop）全部可表达。

### 双通道状态访问

同一工作流状态目录可通过两条路径访问：

1. **进程内**：OpenClaw 插件工具——正常 skill 执行时使用。
2. **进程外**：MCP server over stdio——外部 MCP 客户端使用。

两条路径写入前都经校验。（历史依据：[`archive/contracts/state-contract.md`](archive/contracts/state-contract.md)。）

### 委托给宿主

omm 不自建自主循环 / 目标 / 并行原语，而是委托宿主：

- **OpenClaw Gateway**：插件加载、工具分派、skill 执行引擎
- **团队并行**：`TeamCreate`/`TaskCreate`/`SendMessage`
- **自主循环与目标**：宿主的 `@openclaw/autopilot`

（见 [ADR-002](adr/002-team-delegation-to-host.md)、[ADR-008](adr/008-delegation-to-host.md)。）

## 运行时安全（subagent guard）

OpenProse 扇出的 subagent 在 OpenClaw gateway 的 `before_tool_call`（priority 11）受运行时守卫保护，fail-closed 拦截 destructive 操作：

- **所在**：`@openclaw/dynamic-workflows` plugin（guard）+ `@openclaw/permission-policy`（原语库）；autopilot 与 dynamic-workflows 互不依赖（ADR-011→012→013）。
- **威胁模型**：subagent 不可信（可能被 prompt 诱导）；主 session agent 是第一道防线，guard 是 defense-in-depth。
- **拦截**：读真实事件 `params.command`，按 shell 操作符（`&&`/`&`/`|`/`;`/换行）拆段逐段分类；`destructive git`（reset --hard / force-push / clean）、文件清除（`rm` / `find -delete`）、credential / system-write、shell substitution（`$(...)`）、wrapper-exec（`npx` / `pnpm exec`）在 `:subagent:` 会话 hard-block。
- **已知局限**：tokenize-based（非 shell parser）——redirect 写 `>file`、未知非 shell 框架工具、引号内 split。详见 [docs/fixes/runtime-guard-event-shape.md](fixes/runtime-guard-event-shape.md) 与 [设计文档 §11.3.3](design/dynamic-workflows-design.md)。

## 后续方向

- live-DAG UI（复用 MA `WorkflowGraph` 套件可视化 .prose 执行进度）
- `budget` 真实 token 缩放、嵌套工作流
- 对抗配方端到端验证（tournament/adversarial-verify 等模式的真实规模测试）
- `api.runtime.subagent` 直接派发作为 OpenProse 之外的补充路径（E3 已验证可行）

历史 v0.x 实现设计记录见 [`archive/`](archive/)。
