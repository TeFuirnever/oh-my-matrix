# E1 — checkpoint 根统一

**仓**: oh-my-matrix `packages/autopilot/`
**缺口**: P0-2
**阻塞**: E5（台账复用同一根）
**被阻塞**: 无 —— 可立即开工
**设计文档**: §5.1、§4 P0-2

---

## 问题

写路径与读路径用**不同的根**：

| 方向 | 根 | 出处 |
|---|---|---|
| **写** | `state.workspace?.root ?? process.cwd()` | `resolveCheckpointRoot`，`index.ts:207-209` |
| **读** | 硬编码 `process.cwd()` | `register()` 的 `listResumableCheckpoints`（`index.ts:493`）、`session_start` 的 `lookupRunIdBySessionKey`（`:980`） |

净效果：**用户一旦配置 workspace，崩溃恢复就结构性不可能**。磁盘取证印证——唯一真实 checkpoint 在 `TestProject/.autopilot/checkpoints/`（用户选的 workspace），而 gateway 的 cwd 是 OpenClaw 安装目录，其下**没有 checkpoints 目录**。

## 致命交互

evidence gate **只在配了 `workspacePath` 时**才有约束（`index.ts:1207-1213`）。于是当前架构下「完成判定有效」与「崩溃可恢复」**互斥**——二者不可兼得。这是本缺口比表面看起来更严重的原因。

## 做什么

统一 checkpoint 根。checkpoint 是**引擎协调状态，不是 workspace 内容**——把它移出用户工作区，与 ADR-008（worktree 管理委托 host）一致。

顺带做（同一文件、同一次改动）：
- tmp 文件崩溃残留清扫（`state-persister.ts:181` 写 tmp 后崩溃会留垃圾）；
- 写失败当前 fail-silent（`:205-207`）——磁盘满时恢复能力静默丢失，应至少告警。

## ⚠️ 迁移必须做，且容易漏

需从旧位置（`{workspaceRoot}/.autopilot/checkpoints/`）读取并搬到新位置后删除旧文件。

**但正因为本缺口，旧位置的 checkpoint 目前根本读不到**——迁移代码必须显式扫描候选根（当前 cwd + 已知 workspace 路径），否则**迁移本身会漏**。这条反直觉，别写成「从默认位置读一下」。

CHANGELOG 标 minor。

## ⚠️ 勿混同名字段

删/改时注意区分：

- **`state.workspace.root`**（`index.ts:208`、`:879`）—— 本 ticket 的对象，checkpoint 根，**核心数据**；
- **`workflow.workspace.root`**（WORKFLOW.md 配置项）—— E9 要删的死配置，运行时不消费。

误删前者即毁掉持久化。

## 验收

- [x] 写路径与读路径使用同一个根（getCheckpointRoot，form A：`~/.matrix`）
- [ ] 配置 workspace 的 run 崩溃后可恢复（**实测**）—— MA/手动端到端，OMM 单测外；OMM 侧用 5 个集成/单元测试钉死（迁移、自跳、不孤儿、tmp 清扫、register 接线）
- [~] 旧位置 checkpoint 迁移 —— **部分**：cwd 位置已迁移；**workspace 散落的无法自动发现**（form A 无 registry，form B 被驳回）—— 见下方「状态」
- [x] tmp 残留有清扫（listResumableCheckpoints 扫 `.tmp.*` 孤儿）
- [x] 写失败不再静默（pre-existing `_writeFailureCount++` + console.error）
- [x] 回归基线：autopilot 881 passed（超原 857，因新增测试）

## 状态（2026-08-08 实施完成）

commit `1f4a230`（branch `autopilot-engine-e1-e11-e12`）。form A 固定根，5 个 call site 全统一。

⚠️ **迁移局限（AC「含 workspace 路径下的」不可达）**：form A 无 workspace registry，无法自动发现历史 `state.workspace.root` 下的 checkpoint。只迁移 cwd 位置（gateway 安装目录）。**forward 全部新 checkpoint 落固定根**，故这是一次性遗留——workspace 散落的需手动搬。已在 commit message + 迁移函数注释写明。

⚠️ **symlink 陷阱（已修）**：macOS `/var` ↔ `/private/var`——override（mkdtemp 原始 `/var/...`）与 process.cwd()（解析为 `/private/var/...`）字符串不同但 realpath 同一目录。迁移的 same-path 检查改用 `getCheckpointDir`（realpathSync）canonical 比较，否则会「迁移即自删」。回归测试覆盖。
