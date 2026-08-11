# 05 — MA 宿主升级 4.1.0/1.1.0 + bundle 重建

**What to build:** MA 宿主拿到新引擎 + 新角色库——package.json 升级 @oh-my-matrix/autopilot 4.1.0 + dynamic-workflows 1.1.0 + pnpm install + **bundle:openclaw 重建**（记忆标注的生产发布必需步骤）+ smoke 验证。

**Blocked by:** 发布（已完成：npm + tags + releases）

**Status:** ready-for-agent

- [ ] MA package.json 三行升级 + pnpm install
- [ ] bundle:openclaw 重建（生产打包产物）
- [ ] smoke-plugin-runtime.mjs 通过（唯一 sessionKey 坑）
- [ ] init-skills 触发后角色库 19 个到位

## 参考
memory ma-host-plugin-state（dev 路径已生效但 bundle 未重建）；docs/runbooks/npm-release.md。
