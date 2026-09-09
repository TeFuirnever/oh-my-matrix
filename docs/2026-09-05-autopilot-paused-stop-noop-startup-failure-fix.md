# Autopilot paused 状态 stop 空操作导致「自动驾驶启动失败」修复设计

> **状态**：已修复（2026-09-05 定位，2026-09-07 核验，2026-09-09 方案 A 落地于 `packages/autopilot`，待发版 + MA re-vendor）
> **严重程度**：P1（paused 会话永久卡死，唯一出路为重启网关）
> **现象**：用户反馈 UI 提示「自动驾驶没能启动起来」
> **日志**：`logs/auto/matrixassistant-2026-09-03.log`（41,297 行，含 616 处 autopilot 提及）
> **影响版本**：`@oh-my-matrix/autopilot` 4.4.0（npm latest，上游无修复版本）
> **关联**：与 `autopilot-runtime-stuck-startup-failure-fix.md`（R1-R6，2026-07-31）**不同根因**——前者覆盖 activate 分类 / stall 死循环 / 降级静默，本文档为独立的第 7 个根因：`stop_requested` reducer 不接受 `blocked` orchState。

## 1. 背景

用户反馈：paused 状态的 autopilot 会话，再次启动时提示「自动驾驶启动失败」。反复出现 5 次（17:33:03 / 17:33:53 / 17:35:24 / 17:36:44 / 17:36:54），均为同一 session `agent:role-14af8d:session-1788339188756-nf189v`。

## 2. 日志证据链

| 时间 | 行号 | 事件 |
|------|------|------|
| 17:33:03 | 19061 | `[autopilot] activate rejected: status=paused` |
| 17:33:03 | 19068 | `autopilot.stop result: {"ok":true}` |
| 17:33:03 | 19069 | `[autopilot] activate rejected: status=paused`（**stop 之后仍 paused**） |
| 17:33:53 | 19144 | `activate rejected: status=paused` |
| 17:33:53 | 19151 | `autopilot.stop result: {"ok":true}` |
| 17:33:53 | 19152 | **4ms 后** `activate rejected: status=paused` |
| 17:33:53 | 19159 | `[handleSend] autopilot activate aborted`（toast 触发） |

核心事实：`autopilot.stop` 返回 `{"ok":true}`，但 session 状态未被清除，4ms 后的重试 activate 仍然 `status=paused`。同一模式重复 5 次，非偶发。

## 3. 根因

### 3.1 触发链

1. session 因某 pause 原因（重试耗尽 / 工具反复报错 / loop breaker 等非 user_stopped）进入 `paused`：orchState=`blocked`，blockedReason≠`user_stopped`，经 `deriveStatus` 派生 `status='paused'`（`dist/src/orchestrator.js:46-59`）
2. 用户发新消息 → renderer `activateAutopilotOrAbort`（`src/pages/Chat/components/autopilot-send.ts:151`）调 `autopilot.activate`
3. 插件 activate handler 检查 `state.status`：paused 不在 `['idle','done']` 且 `isRunStuck` = false → reject `cannot activate from status "paused", must be "idle" or "done"`（`dist/index.js:1525/1565`）
4. `autopilot-send.ts:181-190` 捕获 paused 错误 → 调 `autopilot.stop` 后重试 activate（**该兜底逻辑本身正确**）
5. `autopilot.stop` 内部 bug（见 3.2）→ 状态未变，仍 paused
6. 重试 activate 再被拒 → `classifyActivateFailure`（`autopilot-send.ts:97`）仅匹配 `Gateway not connected` / `RPC timeout` / `max_concurrent_reached`，此错误落 `unknown` → toast `autopilot.error.activateFailed` = **「自动驾驶没能启动起来」**（`packages/i18n/locales/zh/chat.json:520`）

### 3.2 核心缺陷：两套状态机词汇表的守卫错位

插件每个 run 有两个字段描述状态，靠纯函数 `deriveStatus` 单向绑定（ADR-016：reducer 是 status 唯一写者）：

- **`orchestrationState`**（内部状态机，7 态）：`unclaimed / claimed / running / retry_queued / released / blocked / done`
- **`status`**（用户可见投影，4 态）：`idle / running / paused / done`

映射关系：`blocked + user_stopped → idle`；`blocked + 其他原因 → paused`；active 五态 → running。

**用户看到的 `paused`，内部真身是 `blocked`。一个状态，两套名字。**

停止流程经过两道守卫，**各查一个字段**：

第一道门（RPC handler，查 `status`，`dist/index.js:1739-1743`）：

```js
if (state.status === 'running' || state.status === 'paused' || state.status === 'done') {
    const orchestrated = orchestratorReducer(state, { type: 'stop_requested', runId, now: Date.now() });
    setState(runId, orchestrated);
    log(`[autopilot] stop: ... ${state.status}→idle`);
}
respond(true, { ok: true });
```

paused 在列表里，放行。

第二道门（reducer，查 `orchestrationState`，`dist/src/orchestrator.js:308-311`）：

```js
case 'stop_requested': {
    const stoppable = ['running', 'claimed', 'retry_queued', 'released', 'unclaimed'];
    if (!stoppable.includes(state.orchestrationState))
        return state;   // ← paused run 的真身是 blocked，不在列表，原样返回
    ...
}
```

`blocked` 不在 stoppable 列表，拦截，原样返回同一引用。

**错位就在这**：第一道门的 `{running, paused, done}` 与第二道门的 `{running, claimed, retry_queued, released, unclaimed}` 是两套坐标系。paused（用户词汇）放行了，blocked（内部词汇）被拦——而它们是同一个状态。若两道门查同一字段，此 bug 不可能存在。

作者大概率思路是「stop 的目标态就是 `blocked/user_stopped`，已 blocked 的再 stop 无意义」——这对 `blocked+user_stopped`（已停）成立，但对 `blocked+其他原因`（**暂停≠停止**，run 还挂着）不成立。失手根源：`blocked` 不是单一状态，是以 `blockedReason` 为参数的一族状态，stoppable 检查只看了族长没区分族内成员。

### 3.3 次要缺陷：谎报成功 + 日志撒谎

reducer 不可变，no-op 返回**同一对象引用**。handler 拿到后：

1. `setState(runId, orchestrated)`——把一模一样的状态写回（等于什么都没做）
2. 不检查 `orchestrated !== state`（引用相等 = 状态未变）
3. 无条件 `respond(true, { ok: true })`（`dist/index.js:1752`）
4. 顺手打日志 `paused→idle`（`dist/index.js:1743`）——**宣告一个从未发生的转移**，加重排障难度

调用方（MA renderer）拿到「停止成功」假情报，重试 activate，4ms 后再次被拒，循环 5 次。

### 3.4 实现违背自己的设计文档

`docs/core/autopilot/design.md:477` 状态图明确写着：

```
blocked --> idle: stop_requested
```

设计本来就要求 stop 从 blocked 转移到 idle，实现偏离了设计。且同文件 `hard_stop_requested`（`orchestrator.js:368-372`）就是正确范式：只豁免 `done` 和 `blocked+user_stopped`，其余 blocked 一律允许重新转移——`stop_requested` 没照此写。`deriveStatus` 也专门为 `blocked+user_stopped → idle` 写了分支，整条停止链路的设计意图都在，唯独 stoppable 列表没跟上。

## 4. 代码核验结论（2026-09-07）

对 `resources/claw-plugin/autopilot-4.4.0.tgz` 解包逐条核验（注意：vendored `dist/` 为构建时生成且被 .gitignore，代码真身在 tgz 与上游源仓）：

### 4.1 主张逐条核验（7/7 实锤）

| # | 主张 | 结论 | 证据 |
|---|------|------|------|
| 1 | `deriveStatus`：blocked+user_stopped→idle，其他→paused | 一致 | orchestrator.js:46-59 逐字吻合 |
| 2 | stoppable 列表漏 `blocked` → paused no-op | 实锤 | orchestrator.js:309-311 |
| 3 | handler 判 `status` vs reducer 判 `orchestrationState` 错位 | 实锤 | index.js:1739 vs orchestrator.js:309 |
| 4 | stop 谎报 `ok:true` | 实锤（无条件 respond + 日志宣称 paused→idle） | index.js:1752 / 1743 |
| 5 | activate 拒 paused，`isRunStuck` 不救场 | 实锤——`isRunStuck` 明确 scoped to `running` only（autopilot-state.js:140-141，注释称 "paused is an intentional, user-resumable state"，对非 resumable 原因是反讽） | index.js:1525/1565 |
| 6 | renderer stop+retry 兜底逻辑正确无责 | 一致 | autopilot-send.ts:181-190 |
| 7 | toast 走 unknown 兜底 | 一致 | zh/chat.json:520 |

### 4.2 替代解释排除（原「诚实边界」销案）

穷尽审计插件全部 36 个 `setState` 写入点、60s patrol 定时器与恢复路径：

- 60s patrol 的 hard cap / stall / no_progress 分支均要求 `enabled && status==='running'`，retry_due 要求 `orchestrationState==='retry_queued'`——paused run 的 `enabled=false`（pause_requested 已置位），patrol 不可能重写
- register 时恢复只认 5 种 active orchState，blocked 不恢复
- session_start 的 `loadCheckpoint` 无过滤可恢复 paused run，但仅在**网关重启后**触发——4ms 进程内窗口无其他写入者

结论：stop 后仍 paused 的唯一解释就是 reducer `return state` 的 no-op。静态但穷尽，替代解释排除。

### 4.3 影响面（比原稿更广）

- stop no-op 对**全部 19 种 blockedReason**（`types.js:9-29`）一律生效，与原因无关
- 其中 13 种非 resumable 原因（max_retries_reached / tool_error_repeated / loop_breaker_triggered / context_overflow_unrecoverable / max_duration_reached / max_cost_reached / token_budget_exceeded / permission_denied / workspace_* / config_invalid / unrecoverable_error）的 paused run 是**彻底死局**：

| 逃生口 | 守卫 | 结果 |
|--------|------|------|
| resume | blockedReason ∈ RESUMABLE_BLOCKED_REASONS（仅 stalled / validation_failed / evidence_missing / injection_rejected / no_progress 五种，orchestrator.js:19-25） | 非成员被拒 |
| stop | 本 bug | 空操作 + 谎报成功 |
| activate | status ∈ {idle, done}；isRunStuck 只救 running | paused 两头不沾 |

三条路全堵 → 唯一出路重启网关（内存态丢弃，register 恢复不认 blocked）。

- 顺带发现：`done` 状态 stop 同样是 reducer no-op + 日志撒谎，但 activate 允许 done，无害。

### 4.4 勘误（相对初稿）

1. `max_attempts_reached` 是 PauseReason 且**无生产 dispatch 点**（turn 上限走 cross_turn 不走 pause），映射后的 BlockedReason 实为 `max_retries_reached`（types.js:55）
2. `loop_breaker` 实际值为 `loop_breaker_triggered`（index.js:1338）
3. toast 文案行号为 zh/chat.json:**520**（非 507）
4. 代码引用路径：`resources/claw-plugin/autopilot/dist/...` 为构建时产物（.gitignore），持久真身在 `resources/claw-plugin/autopilot-4.4.0.tgz` 与上游 `oh-my-matrix/packages/autopilot/src/`

## 5. 责任划分

| 层 | 行为 | 责任 |
|----|------|------|
| `orchestrator.js:309` stop_requested reducer | stoppable 列表漏 `blocked` | **主因** |
| `index.js:1727-1753` stop handler | reducer no-op 仍 `respond:ok:true`，且日志宣称未发生的转移 | 次因（谎报成功） |
| `autopilot-send.ts:181-190`（MA renderer） | paused → stop+retry 兜底 | 逻辑正确，无责 |
| 其他 pause 触发者 | pause 原因合法 | 无责 |

非 MatrixAssistant 核心代码问题，非网关 / IPC 透传层问题。根因在 autopilot 插件（上游 oh-my-matrix 仓）。

## 6. 修复方案

### 6.1 方案 A：reducer 补 `blocked`（根治，推荐）

`orchestrator.js:309` stoppable 列表加入 `'blocked'`（上游对应 `packages/autopilot/src/orchestrator.ts`）：

```js
const stoppable = ['running', 'claimed', 'retry_queued', 'released', 'unclaimed', 'blocked'];
```

修复后链路自动理顺：`blocked(任意原因)` → 转移为 `blocked/user_stopped` → `deriveStatus` → `idle` → activate 畅通（建新 run，旧 run 丢弃）。

### 6.2 方案 B：stop handler 校验状态变更（叠加）

reducer 结果与旧 state **引用比对**（reducer 全 immutable，no-op 返回同一引用），引用相同则 `respond(false)` 并携带明确错误码，杜绝谎报成功。可一次性堵住同类问题（含 done 的 cosmetic 撒谎）。

### 6.3 安全性核验（10 项全过）

| 检查项 | 结论 |
|--------|------|
| blocked+user_stopped 幂等（此时 status='idle'，RPC 第一道门不放行，到不了 reducer） | 天然幂等 |
| 二次 stop（已 idle）走 RPC guard 直接跳过 | 无副作用 |
| stop 后 `persistAfterTransition` 删 checkpoint（index.js:376 对 user_stopped 删 checkpoint + 清 session index） | 符合 user_stopped 终态语义 |
| `resume_requested`：user_stopped 不在 RESUMABLE 集合 | stop 即终态，语义正确 |
| `hard_stop_requested`:371 豁免 user_stopped 不被覆盖 | 无冲突，且 hard_stop 本就有重阻塞 blocked 的先例 |
| audit refcount：仅 `status==='running'` 释放，paused 已在 pause 时释放 | 无 over-release |
| `projection.canStop` 本就为 paused 显示停止按钮 | 修复让按钮真正生效 |
| renderer 侧 `user_stopped` 仅存在于 i18n 映射 | 无行为特判可破坏 |
| 修复后 blocked+resumable 原因被 stop 覆盖为 user_stopped | 即用户显式停止，预期行为 |
| `enabled:false / pauseReason / needsCrossTurnResume / degraded` 随 reducer 原子清理 | 与 stop_requested 既有转移一致 |

**附带收益**：修复后 renderer 现有 stop+retry 兜底（autopilot-send.ts:181-190）自动变为可用路径——stop → idle → activate 成功，MA 侧主流程零改动。

## 7. 实施路径（供应链约束）

### 7.1 手改 vendored 产物结构性不可行（三重锁）

| 锁 | 机制 |
|----|------|
| build 覆盖 | `scripts/install-omm-plugin.js:65` 每次 build `rmSync` 重拷 dist |
| git 不收 | `dist/` 在 .gitignore，补丁提交不进仓库 |
| tgz 哈希锁定 | 真正装到用户网关的是 `autopilot-4.4.0.tgz`，被 `tests/unit/autopilot/plugin-registry-sha256-invariant.test.ts` 逐字节 sha256 锁定 |

### 7.2 上游现状（2026-09-07 查证）

- npm `@oh-my-matrix/autopilot` latest = **4.4.0**（2026-08-12 发布），即 MA 当前 vendored 版本——**无升级路径**
- 上游 `github.com/TeFuirnever/oh-my-matrix` 的 `packages/autopilot` 最后提交为 2026-08-12（4.4.0 版本提交本身），此后零提交；issue 区无此 bug 记录
- 上游与 MA 为同一作者维护（woshiguanxiaoliang 是上游主要提交者），修复无协作成本；上游有 changesets + GitHub Actions 自动发版

### 7.3 正确流程（照抄 R6 与 4.4.0 升级先例）

1. **上游**：修 `packages/autopilot/src/orchestrator.ts` stop_requested 分支（+ 可选方案 B 于 `src/index.ts`），补插件层回归测试（见第 8 节），changeset 发版（4.4.1）→ npm publish
2. **MA 侧重新 vendor**：bump 根 package.json 依赖 → `pnpm install` → `node scripts/install-omm-plugin.js autopilot` → 提交新 tgz + `resources/plugins/plugin-registry.json` 哈希（先例：R6 的 3.0.3→3.1.0 re-vendor，4.4.0 升级 commit `b3c750d42`）

## 8. 回归测试建议（插件层，随上游修复落地）

测试只能写在上游仓（tgz 不含测试文件）：

```text
场景：paused(非 user_stopped) run 调 autopilot.stop
断言：orchestrationState 仍为 'blocked' 且 blockedReason='user_stopped'
      deriveStatus 派生 status='idle'
      checkpoint 已删除（persistAfterTransition 终态清理）
      二次 stop 幂等（RPC guard 拦截，respond ok）
场景：blocked+user_stopped（已 idle）调 stop → 不进 reducer 分支，respond ok
场景（方案 B）：reducer no-op 时 respond(false)，错误码可被 MA 分类器识别
```

## 9. MA 侧可选加固（防御纵深，不修主流程也可）

`classifyActivateFailure`（`autopilot-send.ts:97`）增加识别 `cannot activate from status "paused"` → 定向 toast（如「上次自动驾驶已暂停，停止后重试」），并同步更新契约测试（`tests/unit/autopilot/chatinput-autopilot-mode.test.ts` 已有 unknown 兜底用例可参照；注意 autopilot-send.ts:76-85 注释声明错误字符串为未版本化契约，改词需过契约测试）。插件修复后此路径极少触发，属锦上添花。

## 10. 模式归因（历史规律视角）

对照 `docs/archive/bug-fix/` 归档梳理，本 bug 是两族复发模式的交集新实例：

- **状态字段错位 / 双状态机**：concurrent-streaming-render-bug（全局 Zustand vs per-session Map）同族——两套词汇表各自守卫，翻译层只做了单向
- **无效操作谎报成功 / 假开关**：mcp-disable-toggle-fake-fix（disabled 字段无人消费）同族——操作无效果但报告成功

建议后续状态机改动沿用 ADR-016「单一写者 + 派生」的思路收敛守卫字段，方案 B 的引用比对可作为该模式的通用防线。

## 11. 诚实边界

- 根因判定 = 日志时间证据（实锤）+ 代码静态核验（7/7 主张逐条对照 4.4.0 tgz 真实代码）+ state-writer 全量审计（36 写入点穷尽，替代解释排除）
- **未做动态复现**（未在运行中网关复现 paused → stop → activate）。动态验证方法（可选）：构造 paused run，调 `autopilot.stop` 后查 `autopilot.status`，确认派生状态是否 'idle'
- blockedReason 影响面（19 种全受影响）基于类型全集与写入点静态推断，未逐一构造场景验证
- 上游「无修复版本」结论基于 npm dist-tags 与 GitHub master 提交记录（2026-09-07 查证时点）

## 12. 文件清单（待修复）

| 位置 | 文件 | 改动 |
|------|------|------|
| 上游 oh-my-matrix | `packages/autopilot/src/orchestrator.ts` | `stop_requested` stoppable 加 `'blocked'`（方案 A） |
| 上游 oh-my-matrix | `packages/autopilot/src/index.ts`（可选） | stop handler 引用比对，no-op 则 respond(false)（方案 B） |
| 上游 oh-my-matrix | `packages/autopilot` 测试目录 | 第 8 节回归测试 |
| MA（re-vendor 产物） | 根 `package.json` / `resources/claw-plugin/autopilot-*` / `resources/plugins/plugin-registry.json` | 依赖 bump + 新 tgz + 哈希同步 |
| MA（可选加固） | `src/pages/Chat/components/autopilot-send.ts` + 契约测试 | paused 错误分类（第 9 节） |

## 13. 风险与建议

- 改动面小（reducer 单行 + 可选 handler 校验 + 测试），回归风险低；安全性 10 项核验全过
- 主要流程风险在 re-vendor 环节：需确保 `pnpm install` 拉到新版本、provenance 校验通过（`install-omm-plugin.js` 的 dist 版本自检）
- 修复上线前，受影响用户的临时缓解：重启网关（内存态丢弃后 paused run 不复活）
