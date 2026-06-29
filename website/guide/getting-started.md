# Getting Started

oh-my-matrix 面向 OpenClaw 宿主集成者。当前核心不是“只读文档仓库”，而是一个 private workspace packages + skill 的源码仓库。

## 你会用到什么

| 目标 | 入口 |
|---|---|
| 长程连续执行 | `packages/autopilot/` |
| 多 agent workflow 编排 | `packages/dynamic-workflows/skill/` |
| workflow subagent guard | `packages/dynamic-workflows/` |
| 共享权限原语 | `packages/permission-policy/` |
| 架构背景 | `docs/architecture.md` |
| ADR | `docs/adr/` |

## 本地检查

```bash
pnpm install

pnpm --filter @oh-my-matrix/autopilot test
pnpm --filter @oh-my-matrix/dynamic-workflows test
pnpm --filter @oh-my-matrix/permission-policy test

pnpm docs:dev
pnpm docs:build
```

## 集成现实

仓库源码通过测试不等于宿主已经加载。对 `packages/*` 的改动还需要宿主侧部署：

1. build package
2. pack 或复制 dist
3. 刷新 host bundled-plugin copy
4. restart OpenClaw gateway / MatrixAssistant
5. 跑 deployed-dist smoke check

如果你只是在阅读或贡献 docs，`pnpm docs:build` 就足够。

## 下一步

- [Architecture](/guide/architecture): 当前三模块架构
- [Roadmap](/guide/roadmap): 当前优先级
- [Design Reference](/reference/): ADR 与历史参考入口
