# Host Deploy Runbook

> **状态:WIP 骨架。** 本仓库保存源码与测试;宿主(MatrixAssistant / OpenClaw Gateway)加载的是打包后的 plugin **dist**。源码变更必须走宿主内部部署刷新流程 —— **仓库测试通过 ≠ 线上已生效**。
>
> 本 runbook 收拢 repo 内已知的步骤;标 `[TODO:host]` 的步骤在 MA 仓库内部执行,具体命令/路径需 host 团队补全。这是 [architecture.md Current Gaps](../architecture.md#current-gaps) 第一条("Host deploy remains internal and should be documented as a reproducible runbook")的兑现。
>
> 来源:[CONTEXT.md Host Deploy](../../CONTEXT.md)、[architecture.md Distribution Reality](../architecture.md)、[ADR-010](../adr/010-autopilot-source-hosting.md)、[ADR-012](../adr/012-dynamic-workflows-plugin-extraction.md)、[ADR-013](../adr/013-permission-policy-library.md)、[fixes/runtime-guard-event-shape.md](../fixes/runtime-guard-event-shape.md)。

## 何时用

任一 hosted package 源码变更后:

- `packages/autopilot/`(`@openclaw/autopilot`)
- `packages/dynamic-workflows/`(`@openclaw/dynamic-workflows`)
- `packages/permission-policy/`(`@openclaw/permission-policy`)

三者共享 permission-policy —— **三者同改时,三个都要验**(见 fixes 文档"build 3 个 + cp dist into MA")。

---

## 步骤

### 1. 本仓库:验证源码(已完整可执行)

逐包跑测试,全绿才继续:

```bash
pnpm --filter @openclaw/permission-policy test    # 当前 ~111 tests
pnpm --filter @openclaw/dynamic-workflows test    # 当前 ~12 tests
pnpm --filter @openclaw/autopilot test            # 当前 ~520 tests
```

任一包红 → 先修,不进入部署。

### 2. 本仓库:产出分发产物(已完整可执行)

```bash
# autopilot 走 tgz(MA 以 file: 协议 vendoring,见 ADR-010)
pnpm --filter @openclaw/autopilot build
pnpm --filter @openclaw/autopilot pack            # → packages/autopilot/openclaw-autopilot-<ver>.tgz

# runtime guard 两包走 cp dist(ADR-012/013 + fixes 文档)
pnpm --filter @openclaw/permission-policy build
pnpm --filter @openclaw/dynamic-workflows build
```

产物:`packages/autopilot/openclaw-autopilot-<ver>.tgz` + 三个 `dist/`。

### 3. `[TODO:host]` 刷新 MA bundled-plugin copy

- 把 autopilot tgz 放进 MA 的 `resources/autopilot/`(ADR-010),并在 MA `package.json` 把 `"@openclaw/autopilot"` 版本 bump 到新 tgz 的版本号(tgz 文件名里的版本是合约)。
- 把 permission-policy / dynamic-workflows 的 `dist/` cp 进 MA 的 bundled-plugin 目录。
- `[TODO:host]`:MA 仓库内具体的 cp 目标路径、版本 bump 命令、是否需 `pnpm install` 重建 bundled-plugin 目录。

### 4. `[TODO:host]` 重启 MA gateway

运行中的 MA 进程**缓存了旧 module,必须重启才加载新 dist**(fixes 文档明确:"MA must restart to load")。不重启 = 部署等于没做。

- `[TODO:host]`:MA 的重启方式(launchd / 进程管理器 / 手动)。

### 5. `[TODO:host]` 跑 deployed-dist smoke check(在 host repo,不在本 repo)

**这是唯一的线上验证。** fixes 文档的核心教训:别用虚构 event shape 的单测冒充线上验证 —— 历史 runtime guard 就是这么成了 production placebo(单测全绿,线上 fail-open)。

- `verify-guard`(host repo)驱动**真实** event shape,确认:
  - `destructive` / `cd <ws> && git reset --hard` / `rm -rf` → **blocked**
  - `git status` / main-session → **allowed**
- `[TODO:host]`:`verify-guard` 脚本位置 + 一键调用方式。

---

## 诚实红线

1. **仓库测试绿 ≠ 线上生效**。第 5 步 deployed-dist smoke 是唯一证据。任何 guard 相关变更都要真跑 MA live e2e,不再 defer(这正是历史 placebo bug 的根源)。
2. **不重启 = 旧 module**。第 4 步不可省。
3. **MA 是合约边界**。两个仓库(omm 源码 + MA vendored dist)必须保持同步,tgz 文件名里的版本号是合约(ADR-010 Negative)。

## 已知限制(不藏)

- runtime guard 是 **tokenize-based,非完整 shell parser**。redirect 写文件(`>file`)、未知非-shell 框架工具、引号内 operator 误伤是已知 gap(见 [fixes 文档 Known limitations](../fixes/runtime-guard-event-shape.md#已知限制-tokenize-based-post-review-2026-06-28))。smoke check 应覆盖这些边界。

## Release readiness 待补(把 `[TODO:host]` 填掉,即可视为 runbook 完整)

- [ ] MA 仓库路径 + bundled-plugin 目录结构
- [ ] autopilot tgz 放置 + MA `package.json` 版本 bump 的可执行命令
- [ ] permission-policy / dynamic-workflows 的 `dist/` cp 目标路径
- [ ] MA 重启命令
- [ ] `verify-guard` 脚本位置 + 一键调用
- [ ] (ADR-010 follow-up)把 tgz refresh 自动化(CI step 或脚本),消除手动同步税

## 相关

- [ADR-010](../adr/010-autopilot-source-hosting.md) — autopilot source hosting(tgz + `file:` vendoring)
- [ADR-012](../adr/012-dynamic-workflows-plugin-extraction.md) — dynamic-workflows 插件抽取
- [ADR-013](../adr/013-permission-policy-library.md) — permission-policy 库解耦
- [fixes/runtime-guard-event-shape.md](../fixes/runtime-guard-event-shape.md) — event-shape bug(fail-open 教训 + params-shape 真值)
- [architecture.md](../architecture.md) — Distribution Reality / Current Gaps
