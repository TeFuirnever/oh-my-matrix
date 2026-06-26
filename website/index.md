---
layout: home

hero:
  name: "oh-my-matrix"
  text: "OpenClaw-native orchestration"
  tagline: 文档与设计底座 · team 工作流编排 · 自主循环委托宿主。实现已重置 (0.6.0)，为下一阶段方向铺路。
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /guide/architecture

features:
  - title: team 协作编排
    details: 围绕共享计划的并行代理协作；宿主提供 TeamCreate/TaskCreate/SendMessage 并行原语。
  - title: 委托给宿主
    details: 不自建自主循环 / 目标 / 并行；ralph / autopilot / goal 委托宿主 @openclaw/autopilot。
  - title: 纯插件形态
    details: 无独立 CLI、无原生模块；通过 OpenClaw 插件 API 或 MCP 消费，作为可选增强存在。
  - title: 设计可追溯
    details: v0.x 完整设计记录（ADR / 契约 / 评审）归档保留；脊柱文档标注实现重置、面向未来。
---

## 关于本站

> 🔄 **实现已重置 (0.6.0)** — v0.x 的 OpenClaw 插件 / MCP 实现（`team` 状态机、employee-bridge、hooks、MCP servers）已全部移除。本仓库现为**文档/设计底座**，保留连续方向的概念模型与设计推理。

本站承载 oh-my-matrix 的方向、架构叙事、领域语言与历史决策。代码回归形态待下一阶段确定。

- 浏览 **[Architecture](/guide/architecture)** 与 **[Roadmap](/guide/roadmap)** 了解方向。
- 完整 v0.x 设计记录见仓库 `docs/archive/`。
