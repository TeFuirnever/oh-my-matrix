# Host Integration Runbook

> **状态:WIP 骨架。** 本仓库发布 `@oh-my-matrix/*` npm 包;消费方(host / OpenClaw Gateway)从 npm 安装并在运行时加载。源码变更必须 publish 新版本并被 host 重新加载 —— **仓库测试通过 ≠ host 已生效**。
>
> 本 runbook 收拢 OMM 侧步骤;标 `[TODO:host]` 的步骤在 host 仓库内部执行(具体由各 host 决定)。这是 [architecture.md](../architecture.md) "Host integration remains host-internal" 的兑现。
>
> 来源:[CONTEXT.md](../../CONTEXT.md)、[architecture.md](../architecture.md)、[ADR-010](../adr/010-autopilot-source-hosting.md)、[ADR-012](../adr/012-dynamic-workflows-plugin-extraction.md)、[ADR-013](../adr/013-permission-policy-library.md)、[fixes/runtime-guard-event-shape.md](../fixes/runtime-guard-event-shape.md)。

## 何时用

任一发布包源码变更后:

- `packages/autopilot/`(`@oh-my-matrix/autopilot`)
- `packages/dynamic-workflows/`(`@oh-my-matrix/dynamic-workflows`)
- `packages/permission-policy/`(`@oh-my-matrix/permission-policy`)

三者共享 permission-policy —— **三者同改时,三个都要 publish + 验**(见 fixes 文档)。

---

## 步骤

### 1. 本仓库:验证源码(已完整可执行)

逐包跑测试,全绿才继续:

```bash
pnpm --filter @oh-my-matrix/permission-policy test
pnpm --filter @oh-my-matrix/dynamic-workflows test
pnpm --filter @oh-my-matrix/autopilot test
```

任一包红 → 先修,不进入发布。

### 2. 本仓库:publish 到 npm(真实终端,2FA)

OMM 包以 **npm registry 依赖** 被 host 消费(host `package.json`:`"@oh-my-matrix/<pkg>": "<ver>"`)。源码变更后 publish 新版本。

```bash
# bump 版本(feature→minor / fix→patch),再真实终端 publish(需 2FA)
pnpm --filter @oh-my-matrix/<pkg> publish --access public
```

- npm 版本 **immutable** —— 改了内容必须 bump。
- `pnpm publish` 是 outward-facing,需 2FA(真实终端,非 agent)。
- `pnpm --filter <pkg> pack` 可预览 tarball 内容,无需手动 cp dist。

### 3. `[TODO:host]` host:更新版本号 + 重新加载

host 通过 npm 依赖 OMM 包。publish 后 host 侧:

1. host `package.json` 把 `@oh-my-matrix/<pkg>` 版本号改成新 publish 的版本。
2. `pnpm install`(或等价)拉取新版到 `node_modules`。
3. host 按**自己的方式**重建运行时加载的 plugin copy(如何 bundle 是 host 的实现,OMM 不规定)。
4. 重启 host gateway(加载新代码,见 step 4)。

- `[TODO:host]`:各 host 的 bundle/加载机制(从 `node_modules`、打包资源、还是别处)。OMM 只保证 npm 包内容正确。

### 4. `[TODO:host]` 重启 host gateway

运行中的 host gateway 缓存了旧 module,**必须重启才加载新版本**(fixes 文档:"host must restart to load")。不重启 = 部署等于没做。

- `[TODO:host]`:各 host 的重启方式。

### 5. 跑 deployed-dist smoke check(在 host 侧,不在本 repo)

**这是唯一的线上验证。** fixes 文档核心教训:别用虚构 event shape 的单测冒充线上验证 —— 历史 runtime guard 就是这么成了 production placebo(单测全绿,线上 fail-open)。

- 真实 event shape smoke,确认:
  - `destructive` / `cd <ws> && git reset --hard` / `rm -rf` → **blocked**
  - `git status` / main-session → **allowed**
- **MA host 曾实现但当前不可用**：`scripts/smoke-plugin-runtime.mjs`(加载 node_modules 的插件 dist → register → 12 hooks + 7 RPC 表面 → activate 后 destructive git blocked / safe allowed)。2026-08-09 对 autopilot 4.0.0 跑通。**注意(2026-08-18 核实)**：该脚本提交在 MA 仓悬空 commit `ddb6246e` 上,未合入任何分支,当前 dev 工作区无此文件;恢复/重建由 issue #171(T16)跟进。
- 注意:插件 dist 运行时**零 openclaw import**(类型擦除),但 SDK 路径是 `openclaw/plugin-sdk/plugin-runtime`(exports 暴露),不是 `openclaw/dist/...`。
- **插件版本升级**:MA 侧改 `package.json` 三包版本 + `pnpm install` 即生效(dev 路径);打包发布走 `bundle:openclaw` 重构建。升级后旧 checkpoint 会被真实恢复(幂等 activate 拒绝) —— smoke 用唯一 sessionKey 规避。
- **autopilot model-routing / thinking-intensity 变更**:另跑 [model-routing-smoke.md](model-routing-smoke.md)(分级 effort + tier override + subagent 覆盖 e2e + 不干预)—— subagent 覆盖目前只有源码推断,smoke 是唯一运行时证据。

---

## 诚实红线

1. **仓库测试绿 ≠ host 已生效**。第 5 步 deployed-dist smoke 是唯一证据。任何 guard 相关变更都要真跑 host live e2e,不再 defer(这正是历史 placebo bug 的根源)。
2. **不重启 = 旧 module**。第 4 步不可省。
3. **host 是合约边界**。OMM(publish 的 npm 版本)与 host 加载的版本必须同步 —— host `package.json` 版本号是同步手段。npm 版本 immutable,publish 前 bump 是硬要求。

## 已知限制(不藏)

- runtime guard 是 **tokenize-based,非完整 shell parser**。redirect 写文件(`>file`)、未知非-shell 框架工具、引号内 operator 误伤是已知 gap(见 [fixes 文档](../fixes/runtime-guard-event-shape.md))。smoke 应覆盖这些边界。

## Release readiness 待补(把 `[TODO:host]` 填掉,即可视为 runbook 完整)

- [ ] 各 host 的 bundle/加载机制(从 `node_modules` / 打包资源 / 别处)
- [ ] host `package.json` 版本更新的具体流程
- [ ] host 重启命令
- [ ] deployed-dist smoke 脚本/方式
- [ ] (ADR-010 follow-up)bundle 自动化(消除手动同步税)

## 相关

- [ADR-010](../adr/010-autopilot-source-hosting.md) — autopilot 源码托管(从 host 抽取到 OMM)
- [ADR-012](../adr/012-dynamic-workflows-plugin-extraction.md) — dynamic-workflows 插件抽取
- [ADR-013](../adr/013-permission-policy-library.md) — permission-policy 库解耦
- [fixes/runtime-guard-event-shape.md](../fixes/runtime-guard-event-shape.md) — event-shape bug(fail-open 教训 + params-shape 真值)
- [architecture.md](../architecture.md) — Distribution Reality / Current Gaps
