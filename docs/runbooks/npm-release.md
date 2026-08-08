# npm Release Runbook

> 本仓库发布 `@oh-my-matrix/*` 到 npm。**每个 npm 版本都应在 GitHub 上有对应的 tag + release**,使其对外可追溯。历史曾缺失(见 [§历史 backfill](#历史-backfill)),本 runbook 把这条流程钉下来。

> 相关:[host-deploy.md](host-deploy.md)(host 怎么消费 npm 版本)、[ADR-010](../adr/010-autopilot-source-hosting.md)、[architecture.md](../architecture.md)。

## 何时用

每次 `npm publish` 一个包的新版本后立即执行。三个发布包:

- `packages/autopilot/`(`@oh-my-matrix/autopilot`)
- `packages/dynamic-workflows/`(`@oh-my-matrix/dynamic-workflows`)
- `packages/permission-policy/`(`@oh-my-matrix/permission-policy`)

## 命名约定

- **包级 tag**:`<pkg>-v<ver>` —— 例如 `autopilot-v2.2.0`、`dynamic-workflows-v0.1.2`、`permission-policy-v0.1.1`。
- **整仓 tag**:形如 `v0.8.0`,是 repo 级里程碑(如 "First public release"),**不是**单包版本号。
- 两套不冲突:包级 tag 带包名前缀,整仓 tag 无前缀。npm 版本只对应包级 tag。

> 包级 tag 前缀用**短名**(`autopilot` / `dynamic-workflows` / `permission-policy`),不带 `@oh-my-matrix/` scope —— 避免 git tag 里的 `@` / `/` 给工具链添麻烦。

## 正向流程(forward)

```
bump 版本 + commit → CI 绿 → npm publish(真实终端 2FA)→ 打 tag + 建 release
```

1. **bump 版本** `packages/<pkg>/package.json`,commit 用 conventional:`chore(<pkg>): bump to X.Y.Z`。用 changeset 时(bump 提交在 `pnpm changeset version` 之后)必须再跑 `node scripts/sync-plugin-versions.cjs` —— 否则 `openclaw.plugin.json` 和 `index.ts` 的 `export const version` 会漂移,publish 的 pre-flight 直接拦(2026-08-09 踩过:1.0.0 bump 后 plugin.json 停在 0.2.0)。
2. **CHANGELOG** 记一条该版本变更。
3. **CI 绿**(`pnpm verify` + CI 全过)再发。
4. **host smoke(autopilot 前置 gate)**—— 真实 openclaw 宿主装本次版本跑一轮(注册、loop 转 2-3 轮、pause/resume)。仓库测试绿 ≠ host 已生效(placebo bug 教训,host-deploy.md §5);2026-08-09 4.0.0 发布时漏做此步,先发后补 —— 发布 gate 顺序:host smoke **在** publish 之前。host 环境在消费方(MA 侧 `node_modules/.bin/openclaw`)。
5. **npm publish** —— 真实终端,2FA OTP。见 memory `npm-publish-flow`。**用 `./scripts/publish.sh`**(pre-flight 版本校验 → build → 按依赖序发布 → `verify-publish.sh` 产物检查),它强制 `npm_config_registry=https://registry.npmjs.org/` —— 开发机 `~/.npmrc` 配了镜像 registry(如 npmmirror)时,裸 `npm publish` 会发错目标、`npm whoami` 也会假失败(2026-08-09 踩过)。
6. **打 tag + 建 release**(一步完成,tag 建在 version-bump commit 上):

   ```bash
   gh release create <pkg>-v<ver> \
     --target <version-bump-commit-sha> \
     --title "<pkg>-v<ver>" \
     --notes "..."
   ```

7. **release notes**:引 CHANGELOG 该版本条目 + npm 包页面链接。

### 锚点 = version-bump commit

tag 必须落在把 `package.json` 设成该版本的那个 commit(version-bump commit),**不是** publish 时的 master 顶端 —— 后者可能版本号都不对(见 [历史 backfill](#历史-backfill) 的 2.1.2 案例)。

**验证**(每个 tag 打完都查一次):

```bash
git show <pkg>-v<ver>:packages/<pkg>/package.json | grep version
# 必须输出该版本号,否则 tag 打错了
```

## 诚实红线

1. **npm 版本 immutable,publish 前 bump 是硬要求**(与 [host-deploy.md](host-deploy.md) 红线 3 一致)。
2. **tag 锚 version-bump commit,并验证版本号**。打错 commit 的 tag 比没有 tag 更糟 —— 它假装权威实则失真。
3. **agent 跑不了 `npm publish`**(2FA),但 tag/release 这步 agent 可代劳,只要 publish 已完成。
4. **commit 日期 vs 发布时间**:理想上 version-bump commit 在 publish 之前。若从本地脏树 publish、事后才 commit,两者会有偏差 —— 正向流程要求**先 commit 再 publish**,消除这个偏差。

## 历史 backfill

2026-06-29 三个包首次公开发布(与整仓 `v0.8.0` 同一天),但当时没有"publish 打 tag"流程,5 个已发版本长期无 GitHub 追溯。2026-06-30 按 [§命名约定](#命名约定) 回填:

| tag | 锚 commit | commit 日期 | npm 发布时间 | 偏差说明 |
|-----|-----------|------------|-------------|---------|
| `autopilot-v2.1.1` | `26cdbc6` | 06-27 | 06-29 07:18 | 锚点是设 2.1.1 的 commit;2.1.1 横跨 06-27→06-29 多个 commit(开源就绪、security scrub 等),实际发布的代码状态更接近 publish 时的 master 顶端 |
| `autopilot-v2.1.2` | `908a2ab` | **06-30** | **06-29 16:09** | ⚠️ **commit 日期比发布晚 ~8h**:从本地脏树 publish 后才 commit(且被 rebase 重打日期)。发布那一刻 master 顶端仍是 2.1.1。tag 锚在设 2.1.2 的 commit 是诚实选择,但日期不代表发布时刻 |
| `dynamic-workflows-v0.1.0` | `26cdbc6` | 06-27 | 06-29 07:18 | 与 autopilot 2.1.1 同 commit(extraction 同时设两个包版本) |
| `dynamic-workflows-v0.1.1` | `7e9328b` | 06-29 | 06-29 14:03 | 同日,偏差小 |
| `permission-policy-v0.1.0` | `955921a` | 06-27 | 06-29 07:18 | 锚点是 extract commit;首次发布 |

**为什么是"不完美"回填**:早期从本地脏树发布、未即时 commit,git 历史里不存在"状态+时间都精确对得上某次发布"的 commit(2.1.2 已证)。回填锚定 **version-bump commit**(每个 tag 的 `package.json` 版本号可验证正确),日期偏差如实记录在上表 —— 比强行声称精确、或干脆不记录都更诚实。

**从 2.2.0 起**(正向流程生效),每个版本都会有 commit-在-publish-之前、锚点精确的 tag。
