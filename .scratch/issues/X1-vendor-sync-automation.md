# X1 — 引擎产物 vendor 同步脚本

**仓**: MatrixAssistant（脚本）+ oh-my-matrix（构建）
**类型**: 基础设施
**被阻塞**: 无
**设计文档**: §7「改动落在哪个仓」

---

## 问题

**引擎改动不会自动到 MA。** `MatrixAssistant/resources/claw-plugin/autopilot/` 是 `@oh-my-matrix/autopilot` 的**构建产物副本**。每次引擎改动后必须手工：

1. `cd oh-my-matrix/packages/autopilot && pnpm run build && pnpm pack`
2. 把 tgz 与解包目录重新 vendor 进 `MatrixAssistant/resources/claw-plugin/`
3. 同步 `plugin-registry.json` 与 `getTgzPath()` 期望的版本号

**当前状态就是这个流程缺自动化的证据**：解包目录是 3.1.0，而 tgz 只有 `autopilot-3.0.3.tgz`，`plugin-registry.json:6` 还指向 `file:///C:/temp/autopilot-3.0.3.tgz`（M4 修的就是这个）。

## 为什么现在必须做

本轮有 **10 张引擎 ticket**（E1–E10）。每张落地都要走一遍上述流程。没有脚本的话：

- 手工步骤 × 10 轮 = 版本错配几乎必然重现；
- M4 修好的错配会在第一次引擎改动后原样回来。

**M4 修当前的症状，X1 防复发。** 只做 M4 等于没做。

## 做什么

一个同步脚本，至少覆盖：

- 从 oh-my-matrix 构建 + pack；
- vendor 到 `resources/claw-plugin/`（解包目录 + tgz 一致）；
- 版本号写入 `plugin-registry.json`，`downloadUrl` 用相对/协议无关形式（**不要绝对路径，更不要平台特定路径**）；
- 校验：解包目录的 `package.json` version === tgz 文件名 version === registry version，不一致则失败。

## 验收

- [ ] 一条命令完成 build → pack → vendor → 版本同步
- [ ] 三处版本号一致性有自动校验，不一致时**失败退出**（不是警告）
- [ ] `plugin-registry.json` 中无绝对路径、无平台特定路径
- [ ] 在 E1 落地时实跑一次，验证流程通畅
