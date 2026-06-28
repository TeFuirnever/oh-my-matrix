---
layout: home

hero:
  name: "oh-my-matrix"
  text: "OpenClaw Agent Runtime Stack"
  tagline: Autopilot 连续执行 · Dynamic Workflows 多 agent 编排 · Permission Policy 运行时边界。
  image:
    src: /hero.png
    alt: hand-drawn oh-my-matrix runtime stack
  actions:
    - theme: brand
      text: Getting Started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /guide/architecture

features:
  - title: Autopilot
    details: OpenClaw-native continuous execution。目标、重试、stall 检测、证据门、projection、WORKFLOW.md 配置。
  - title: Dynamic Workflows
    details: AI 生成 .prose 编排程序，经 OpenProse 执行 fan-out / pipeline / adversarial verification 等 8 种模式。
  - title: Permission Policy
    details: 共享 command classification、permission decision、audit persistence；subagent guard fail-closed。
  - title: Honest Open Source Surface
    details: 不包装未验证的 release、star 或 adoption。源码、测试、ADR、已知限制公开放在仓库里。
---

## 关于本站

oh-my-matrix 是 OpenClaw 宿主集成栈，不是独立终端 CLI。它把长程连续执行、多 agent 并行编排和运行时安全边界拆成可测试模块。

- 先读 **[Getting Started](/guide/getting-started)**。
- 架构边界见 **[Architecture](/guide/architecture)**。
- 当前路线图见 **[Roadmap](/guide/roadmap)**。
- 历史 v0.x 设计记录在仓库 `docs/archive/`。
