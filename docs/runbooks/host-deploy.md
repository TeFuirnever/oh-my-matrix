# Host Deploy Runbook

> **状态:WIP 骨架。** 本仓库保存源码与测试;宿主(MatrixAssistant / OpenClaw Gateway)加载的是打包后的 plugin **dist**。源码变更必须走宿主内部部署刷新流程 —— **仓库测试通过 ≠ 线上已生效**。
>
> 本 runbook 收拢 repo 内已知的步骤;标 `[TODO:host]` 的步骤在 MA 仓库内部执行,具体命令/路径需 host 团队补全。这是 [architecture.md Current Gaps](../architecture.md#current-gaps) 第一条("Host deploy remains internal and should be documented as a reproducible runbook")的兑现。
>
> 来源:[CONTEXT.md Host Deploy](../../CONTEXT.md)、[architecture.md Distribution Reality](../architecture.md)、[ADR-010](../adr/010-autopilot-source-hosting.md)、[ADR-012](../adr/012-dynamic-workflows-plugin-extraction.md)、[ADR-013](../adr/013-permission-policy-library.md)、[fixes/runtime-guard-event-shape.md](../fixes/runtime-guard-event-shape.md)。

## 何时用

任一 hosted package 源码变更后:

- `packages/autopilot/`(`@oh-my-matrix/autopilot`)
- `packages/dynamic-workflows/`(`@oh-my-matrix/dynamic-workflows`)
- `packages/permission-policy/`(`@oh-my-matrix/permission-policy`)

三者共享 permission-policy —— **三者同改时,三个都要验**(见 fixes 文档"build 3 个 + cp dist into MA")。

---

## 步骤

### 1. 本仓库:验证源码(已完整可执行)

逐包跑测试,全绿才继续:

```bash
pnpm --filter @oh-my-matrix/permission-policy test    # 当前 ~111 tests
pnpm --filter @oh-my-matrix/dynamic-workflows test    # 当前 ~12 tests
pnpm --filter @oh-my-matrix/autopilot test            # 当前 ~520 tests
```

任一包红 → 先修,不进入部署。

### 2. 本仓库:publish 到 npm(真实终端,2FA)

OMM 包以 **npm registry 依赖** 被 MA 消费(MA `package.json`:`"@oh-my-matrix/autopilot": "<ver>"`)。ADR-010 早期描述的 file: tgz vendoring 已被 npm registry + MA 的 `install-omm-plugin.js` 取代(见 step 3)。

```bash
# bump 版本(feature→minor / fix→patch),再真实终端 publish(需 2FA)
pnpm --filter @oh-my-matrix/autopilot publish --access public
# permission-policy / dynamic-workflows 同理
```

- npm 版本 **immutable** —— 改了内容必须 bump。model-routing / thinking-intensity 是新 feature → minor(2.1.2 → 2.2.0)。
- Claude 跑不了 `npm publish`(outward-facing,classifier 拒);必须人工真实终端 + 2FA。
- `pnpm --filter <pkg> pack` 可预览 tarball 内容,无需手动 cp dist。

### 3. `[TODO:host]` MA:更新版本号 + rebuild bundled copy

MA 通过 npm 依赖 OMM 包,但 **Gateway 运行时从 `resources/claw-plugin/` 加载**(extraResources,asar 外),**不是 node_modules**(asar 内、只读)。终端用户不跑 `pnpm install`,所以 publish 后 MA 要重建 bundled copy:

1. MA `package.json` 把 `"@oh-my-matrix/autopilot"` 版本号改成新 publish 的版本。
2. `pnpm install`(拉 npm 新版到 `node_modules/@oh-my-matrix/`)。
3. `pnpm build:plugins` → `scripts/install-omm-plugin.js autopilot` 把 `node_modules/@oh-my-matrix/autopilot` copy 到 `resources/claw-plugin/autopilot/`。脚本是 npm → bundled-plugin 的桥梁(注释明言:"just use npm isn't enough")。

**不改任何逻辑代码** —— 只改版本号 + 重建 bundled copy。permission-policy / dynamic-workflows 同走一个 `install-omm-plugin.js`。

- `[TODO:host]`:MA 是否需完整 `pnpm build:app`(还是单 `build:plugins` 够)、具体重启方式。

### 4. `[TODO:host]` 重启 MA gateway

运行中的 MA 进程**缓存了旧 module,必须重启才加载新 dist**(fixes 文档明确:"MA must restart to load")。不重启 = 部署等于没做。

- `[TODO:host]`:MA 的重启方式(launchd / 进程管理器 / 手动)。

### 5. `[TODO:host]` 跑 deployed-dist smoke check(在 host repo,不在本 repo)

**这是唯一的线上验证。** fixes 文档的核心教训:别用虚构 event shape 的单测冒充线上验证 —— 历史 runtime guard 就是这么成了 production placebo(单测全绿,线上 fail-open)。

- `verify-guard`(host repo)驱动**真实** event shape,确认:
  - `destructive` / `cd <ws> && git reset --hard` / `rm -rf` → **blocked**
  - `git status` / main-session → **allowed**
- `[TODO:host]`:`verify-guard` 脚本位置 + 一键调用方式。
- **autopilot model-routing / thinking-intensity 变更**:另跑 [model-routing-smoke.md](model-routing-smoke.md)(分级 effort + tier override + subagent 覆盖 e2e + 不干预)—— subagent 覆盖目前只有源码推断,smoke 是唯一运行时证据。

---

## 诚实红线

1. **仓库测试绿 ≠ 线上生效**。第 5 步 deployed-dist smoke 是唯一证据。任何 guard 相关变更都要真跑 MA live e2e,不再 defer(这正是历史 placebo bug 的根源)。
2. **不重启 = 旧 module**。第 4 步不可省。
3. **MA 是合约边界**。omm(publish 的 npm 版本)与 MA vendored copy(`resources/claw-plugin/`)必须同步 —— MA `package.json` 版本号 + `build:plugins` 是同步手段。npm 版本 immutable,publish 前 bump 是硬要求。

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
