---
layout: home

hero:
  name: "oh-my-matrix"
  text: "OpenClaw Dynamic Workflows"
  tagline: AI 自主多 agent 编排 · subagent 运行时安全守卫。为 OpenClaw 宿主提供 .prose 工作流生成 + before_tool_call fail-closed 守卫。
  actions:
    - theme: brand
      text: Architecture
      link: /guide/architecture
    - theme: alt
      text: Roadmap
      link: /guide/roadmap

features:
  - title: Dynamic Workflows（8 编排模式）
    details: AI 自动生成 .prose 程序（fan-out-reduce / pipeline / adversarial-verify / loop-until-dry / routing / tournament / generate-and-filter / duel-loop），经 OpenProse 扇出多 agent 并行执行，只回最终结果。
  - title: Subagent 运行时守卫
    details: before_tool_call（priority 11）fail-closed 拦截 destructive git / 文件清除 / credential / shell substitution / wrapper-exec；不可信 subagent 会话 defaultDeny。
  - title: 委托给宿主
    details: 不自建自主循环 / 并行原语；ralph / autopilot / goal 委托宿主 @openclaw/autopilot，运行时由 OpenProse（bundled）提供。
  - title: 纯 skill 包 + @openclaw/* 库
    details: 核心交付是 SKILL.md 包 + 中性 permission-policy 库；无独立 CLI、无原生模块，作为 OpenClaw 集成增强存在。
---

## 关于本站

> 🔄 **方向更新 (0.7.x)** — v0.x 的 team 编排 / MCP / 插件实现已移除（见仓库 `docs/archive/`）。当前方向：**Dynamic Workflows**——AI 自主生成 .prose 编排 + OpenProse 执行 + subagent 运行时守卫。

本站承载 oh-my-matrix 的方向、架构叙事、领域语言与历史决策。

- 浏览 **[Architecture](/guide/architecture)** 与 **[Roadmap](/guide/roadmap)** 了解方向。
- 运行时守卫修复历史（placebo → 真守卫，2026-06-28 live e2e 闭环）见仓库 `docs/fixes/`。
- 完整 v0.x 设计记录（ADR / 契约 / 评审）见仓库 `docs/archive/`。
