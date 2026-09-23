# OpenClaw Subagent 工具拦截 — 排查与修复全指南

> **日期**：2026-09-12
> **环境**：Windows / MatrixAssistant（OpenClaw fork，版本 `2026.7.1-2`）
> **网关配置**：`C:\Users\admin\.openclaw\openclaw.json`
> **插件加载路径**：`C:\Users\admin\Documents\Codes\bug-fix\MatrixAssistant\.worktrees\autopilot-noop\resources\claw-plugin\` 与 `...\resources\plugins\`
> **问题**：subagent 会话中所有网络访问工具（`web_fetch`、`web_search`、`coding`、`browser` 等，以及部分 `exec`/`write` 调用）被禁用；主会话部分工具可用。为什么？怎么放开？

---

## 1. 结论（TL;DR）

**不是 OpenClaw 核心的工具策略管线干的，也不是 `openclaw.json` 配置问题。**

实测证据（`agent:main` 的 4 个 subagent 会话记录）：spawn 时父会话传入的 `inheritedToolAllow` **完整包含** `web_search`、`web_fetch`、`coding`、`browser`——工具确实在 subagent 的模型工具列表里，模型能发起调用。

真正的拦截发生在**工具调用执行时**（toolResult 中 `deniedReason: "plugin-before-tool-call"`），凶手是 MatrixAssistant fork 自带的插件，共两个：

| 拦截者 | 拦什么 | 对谁生效 |
|---|---|---|
| **`dynamic-workflows`** 的 subagent guard | `defaultDeny: true` fail-closed 白名单——分类器不认识的工具/命令一律 block，报 `"Tool X is not on the allowlist for subagent sessions"` | 仅 sessionKey 含 `:subagent:` 的会话（主会话直接放行） |
| **`matrixassistant-audit`** 的规则引擎 | `blacklist.tools: ["web_search"]` 无条件拉黑；91 条审计规则（敏感路径/命令/URL）；medium/high/critical 风险走桌面端确认弹框，**无人应答超时 = high/critical 自动拦截** | 所有会话（含主会话） |

另有第二道锁（`coding` 场景）：`coding-tool` 插件的 opencode worker 执行中提问会挂起等人回答，subagent 无人应答 → 卡到 idleTimeout。

**修复方向**：改 fork 插件（分类器 + 黑名单配置），不是改 `openclaw.json`。

---

## 2. 排查过程与证据链

### 2.1 排除 OpenClaw 核心（版本 `2026.7.1`，与本仓库 HEAD 一致）

OpenClaw 的工具面由分层过滤管线决定（`src/agents/agent-tools.ts:1101-1145`）：

```
tools.profile → provider profile → tools.allow/deny → agent 级 → group 级
→ sender 级 → sandbox 层 → owner-only → subagent 层 → 继承父会话工具
```

- subagent 专属 deny 名单（`src/agents/agent-tools.policy.ts:50-74`）只砍会话/系统工具：
  - `SUBAGENT_TOOL_DENY_ALWAYS`：`gateway`、`agents_list`、`session_status`、`cron`、`sessions_send`
  - `SUBAGENT_TOOL_DENY_LEAF`：`subagents`、`sessions_list`、`sessions_history`、`sessions_spawn`
  - `message` 工具在 spawn 时硬编码禁用（`src/agents/subagent-spawn.ts:1570`）
  - **不含任何网络/编码工具**
- 当前配置 `tools.profile: "coding"` 本身包含 `web_search`/`web_fetch`（`src/agents/tool-catalog.ts:112-126`）
- sandbox 模式默认 `off`（未配置 `agents.defaults.sandbox`），sandbox 层未生效
- 文档佐证：`docs/tools/subagents.md:578-583` — "tools.profile: 'coding' includes web_search/web_fetch"

### 2.2 实测数据（来自 `~/.openclaw/agents/main/sessions/sessions.json`）

4 个 subagent 会话（2026-08-19 ~ 08-25）的 spawn 元数据：

```
spawnDepth = 1, subagentRole = "leaf"
inheritedToolDeny  = ["canvas","gateway","tts","image_generate","music_generate","video_generate","x_search","code_execution"]
                     （= openclaw.json 的 tools.deny，正常）
inheritedToolAllow = ["read","edit","write","apply_patch","exec","process","nodes","cron","message",
                      "agents_list","get_goal","create_goal","update_goal","skill_workshop","update_plan",
                      "sessions_list","sessions_history","sessions_send","sessions_spawn","sessions_yield",
                      "subagents","session_status","web_search","web_fetch","coding","browser",
                      "memory_search","memory_get"]
                     （★ web_fetch / web_search / coding / browser 全在，继承层没砍）
```

### 2.3 定位到插件拦截（transcript 中的 blocked toolResult）

全部会话记录中共 13 次 `plugin-before-tool-call` 拦截：

| 工具 | 次数 | 拦截消息 | 场景 |
|---|---|---|---|
| `web_search` | 5 | `web_search command is disabled` | 主会话 |
| `write` | 3 | `Tool "write" is not on the allowlist for subagent sessions` | subagent |
| `exec` | 6 | `Tool "exec" is not on the allowlist for subagent sessions`（其中 1 条为敏感路径） | subagent + 主会话 |

典型拦截记录（subagent 会话 `80c45e60`，2026-08-22）：

```json
{"role":"toolResult","toolName":"exec",
 "content":[{"type":"text","text":"Tool \"exec\" is not on the allowlist for subagent sessions"}],
 "details":{"status":"blocked","deniedReason":"plugin-before-tool-call",
            "reason":"Tool \"exec\" is not on the allowlist for subagent sessions"},
 "isError":true}
```

主会话 `web_search` 拦截记录（2026-08-19）：

```
"This operation has been automatically blocked due to a security policy violation.
 Reason: web_search command is disabled. You (the AI assistant) must STOP IMMEDIATELY..."
```

---

## 3. 拦截体系全景（分层）

```
模型发起工具调用
 │
 ├─ ① OpenClaw 工具策略管线（agent-tools.ts）
 │    profile/allow/deny/sandbox/subagent层/继承层 → 工具是否出现在模型工具列表
 │    → 本案例：全部放行 ✓（问题不在这层）
 │
 ├─ ② before_tool_call 插件钩子（按 priority 排序执行）
 │    ├─ dynamic-workflows (priority 11)：:subagent: 会话 → 分类器白名单
 │    │    defaultDeny=true，未分类一律 BLOCK ★ 主犯
 │    ├─ autopilot (priority 10)：仅 autopilot 运行 → 破坏性命令黑名单
 │    ├─ matrixassistant-audit：所有会话 → 规则引擎 + 桌面端确认弹框
 │    └─ git-ai (priority 100)：纯观察（git-ai 快照），从不 block
 │
 ├─ ③ 工具执行
 │    └─ coding-tool：opencode worker 内部提问 → question-broker 挂起等人
 │         subagent 无人应答 → 卡到 idleTimeout ★ 第二道锁
 │
 └─ （独立体系）acpx / ACP：编码 agent 会话内权限审批
      permissionMode: approve-all + nonInteractivePermissions: deny
```

---

## 4. 全部 18 个插件的拦截地图

### 4.1 总表

| 插件 | 来源 | 角色 | 拦工具调用？ | 生效范围 |
|---|---|---|---|---|
| **dynamic-workflows** | `@oh-my-matrix` npm 包 | ⛔ subagent fail-closed 白名单 guard | **是** | 仅 `:subagent:` 会话 |
| **matrixassistant-audit** | 仓内源码 `openclaw-extensions/` | ⛔ 全局安全审计引擎 | **是** | 所有会话 |
| **autopilot** | `@oh-my-matrix` npm 包 | ⛔ autopilot 运行命令拦截 + 预算/停滞治理 | 是 | 仅 autopilot 运行及其分支 |
| **acpx**（+acp 配置） | `@oh-my-matrix` npm 包 | ⛔ ACP 编码代理会话内权限审批 | 是 | ACP agent 会话 |
| agent-state-forwarder | 仓内 `resources/plugins/` | 生命周期观察→stderr→Electron | 否 | — |
| git-ai | `~/.openclaw/extensions/git-ai` | file-edit/bash 工具前后打 git-ai 归因快照 | 否（纯观察） | — |
| llm-session-injector | 仓内 `resources/plugins/` | 向 LLM 请求注入 session 元数据（角色名/SDD 步骤） | 否 | — |
| trace-bridge | 仓内 `resources/plugins/` | 模型调用计时→stderr | 否 | — |
| acp-bridge | 仓内 `openclaw-extensions` 类 | Matrix↔ACP 桥 + AGENTS.md persona 注入 | 否 | — |
| matrix-context-controller | Electron 包内 | contextEngine slot（remote `127.0.0.1:1934`），上下文/记忆注入 | 未见拦截钩子 | — |
| memory-core | OpenClaw 上游捆绑 | memory slot：记忆工具 + 梦境日记 subagent | 否 | — |
| browser | OpenClaw 上游捆绑 | 提供 `browser` 工具 | 否 | — |
| open-prose | OpenClaw 上游捆绑 | 长文生成 | 否 | — |
| mcc-persona-toolkit | 仓内 | 提供 caveman/ponytail/adhd 三个 persona 开关工具 | 否 | — |
| sdd-workflow-tool | 仓内 | 提供 `sdd_activate_workflow` 工具 | 否 | — |
| coding-tool（id: coding-process） | 仓内 | 提供 `coding` 工具（opencode worker 流式执行） | 否（但有提问挂起问题） | — |
| register-gateway-method | 仓内 | 注册自定义 gateway RPC | 否 | — |
| archive-restore | 仓内 | 工作区归档/恢复 | 否 | — |

> 注：`matrixassistant-timetravel` 在插件目录中但**不在** `plugins.allow`，未加载。

### 4.2 拦截者 ①：`dynamic-workflows` — subagent 专属 fail-closed 白名单（主犯）

**位置**：`resources/claw-plugin/dynamic-workflows/dist/index.js:123-182`（`before_tool_call`，priority 11，注释明确"高于 autopilot(10)，subagent guard 先拦"）

**核心逻辑**：

```js
function isSubagentSessionKey(sessionKey) {
    return sessionKey.includes(':subagent:');   // 只认 subagent
}
on('before_tool_call', (event, ctx) => {
    if (!sessionKey) return { block: true, ... };      // fail-closed
    if (!isSubagentSessionKey(sessionKey)) return;     // ★ 主会话直接放行
    // ...
    const decision = decidePermissionForEvent(event, {
        workflowAllowsDestructiveGit: false,
        defaultDeny: true,   // ★ subagent: 未分类一律 block
    });
    // block → return { block: true, blockReason: decision.message }
});
```

**分类器**（`@oh-my-matrix/permission-policy` 0.1.4，`dist/src/permission-policy.js`）：

| 类别 | 已知成员 | subagent 中 |
|---|---|---|
| `read_only` | `read`、`read_file`、`rg`、`grep`、`ls`、`cat`、`where`、`findstr`、`cd`、`process`、`update_plan`、`sessions_spawn`、`sessions_yield`、`sessions_list`、`todo_write` 等 | 放行 |
| `workspace_write` | `write_file`、`apply_patch`、`apply_diff`、`code_editor` | 放行（**注意：openclaw 的 `write`/`edit` 不在其中 → 被拦，这是工具名 bug**） |
| `network` | `curl`、`wget`、`git push/fetch/pull/clone`、`pnpm/npm/yarn install` | 放行 |
| `safe_git` | `git status/diff/log/add/commit/branch...` | 放行 |
| `validation` | `npm test`、`npx` | 放行 |
| `destructive_git` | `reset --hard`、`clean`、`restore`、`checkout` 丢弃形态、`push --force`、`commit --amend`、`rebase`、`branch -D`、`tag -d`、`stash clear/drop` | block |
| `workspace_cleanup` | `rm`、`rmdir`、`shred`、`del`、`erase`、`rd` | block |
| `credential_access` | 含 `credential`/`keychain`/`ssh-key` | block（无条件） |
| `system_write` | `sudo`、`chmod`、`runas`、`icacls`、`sc`、`schtasks`、`net start`、`format`、`diskpart`、`reg` 等 | block（无条件） |
| **`unknown`（未分类）** | **`web_fetch`、`web_search`、`coding`、`browser`、`edit`、`write`、`exec`+未知首命令（`python3`/`node`/`pip`）、一切新工具** | **block ★** |

**额外拦截**：shell 替换特性（`$()`、反引号、`<()`）在 subagent 中直接 block（防止分类器被绕过）。

**设计意图**（源码注释）："Untrusted (subagent) sessions: fail CLOSED... This inversion is what makes the subagent guard a real guard, not a placebo."（主会话黑名单模式、subagent 白名单模式，2026-06-28 修复过 fail-open 的 placebo bug）

### 4.3 拦截者 ②：`matrixassistant-audit` — 全局审计规则引擎

**位置**：`resources/claw-plugin/matrixassistant-audit/dist/src/hooks/beforeToolCall.js` + `rules/audit-rules.json`（91 条）+ `rules/audit-config.json`

**决策流**（`beforeToolCall.js:91-341`）：

```
工具调用 → 本地规则引擎评估（91 条规则）
 ├─ 黑名单命中（blacklist.ruleIds / blacklist.tools）→ 直接 block
 ├─ 白名单放行 / 只读自动放行 → allow
 ├─ risk=none/low → allow
 ├─ web_fetch/browser_navigate/browser_web_fetch 的 URL 访问（medium/high）→ 仅记录放行
 ├─ medium → 权限预授权评估（PermissionManager）→ allow/deny/继续
 └─ medium/high/critical → WebSocket 确认弹框到 Electron 桌面端
      ├─ 用户允许 → allow
      ├─ 用户拒绝 → block
      └─ 超时 → critical/high 自动 block；medium 自动 allow ★（无人值守=变相全拦 high 以上）
```

**黑名单**（`audit-config.json:103-106`）：

```json
"blacklist": {
  "ruleIds": ["R1","R2","R3","R4","R22","R40","R41","R42","R43","R44","R52","WEB_SEARCH_DISABLED"],
  "tools": ["web_search"]     ★ web_search 无条件拉黑（所有会话）
}
```

黑名单规则内容（`audit-rules.json`）：

| 规则 | 内容 | 风险 |
|---|---|---|
| R1 | `rm -rf /` 删根目录 | critical |
| R2 | `rm -rf ~/` 删 home | critical |
| R3 / R44 | `format x:`（含 `/y`） | critical |
| R4 | `mkfs.*` | critical |
| R22 | PowerShell `format-volume` | critical |
| R40 / R41 | `rd /s /q`、`rmdir /s /q` | critical |
| R42 / R43 | `del /f /s /q`、`erase /f /s /q` | critical |
| R52 | `fsutil file setzerodata` | critical |
| WEB_SEARCH_DISABLED | 工具名 `^web_search$` | high |

**其他规则面**（91 条 = 88 command + 1 url + 1 query + 1 tool）：

- **敏感路径**（audit-config.json `sensitivePaths`）：`.ssh`、`.gnupg`、`.env`、`.aws`、`.azure`、`.kube`、`.npmrc`、`.pypirc`、`.docker/config.json`、`.secrets`、`C:\Windows`、`C:\Program Files`、`ProgramData`、`~/.openclaw/openclaw.json` 等（部分 `interceptRead: false` 只拦写）
- **敏感文件**：`.pem`/`.key`/`.p12`/`.pfx` 扩展名；文件名/命令含 `password`/`secret`/`token`/`credential`
- **URL/搜索词规则**：含 password/token/internal/intranet/admin/`.onion` → high；可疑域名 `pastebin.com/raw`、`gist.githubusercontent.com`
- **确认弹框**：`wsClient.sendConfirmRequest` → Electron 桌面端；**永不超时等待**，超时分层处理（见上）

### 4.4 拦截者 ③：`autopilot` — autopilot 运行的命令拦截 + 运行治理

**位置**：`resources/claw-plugin/autopilot/dist/index.js:1043-1117`（priority 10）

**生效范围**：仅 `findRunBySession` 命中的 autopilot 运行会话（含经 parent 解析的分支）。普通主会话不受它管。

**工具拦截**（trusted 模式下仍硬拦，同样来自 `permission-policy` 的 `decidePermission`）：

- `credential_access`：credential/keychain/ssh-key → 无条件 block
- `system_write`：sudo/chmod/chown/launchctl/dd/mkfs/fdisk/**runas/icacls/sc/schtasks/net start/format/diskpart/reg** → 无条件 block
- `workspace_cleanup`：rm/rmdir/shred/**del/erase/rd** → block（"user must perform manually"）
- `destructive_git`：见上表 → block（除非 workflow 显式允许且在工作区内）
- 未分类 → **放行**（trusted 黑名单模式）
- 配置加黑：`plugins.entries.autopilot.config.highRiskTools`

**非工具治理**：tokenBudget 超预算终止（before_agent_finalize）、stall 停滞检测与恢复注入、evidence/acceptance-criteria 门。

### 4.5 拦截者 ④：`acpx` / ACP 层 + `coding-tool` 提问挂起

**acpx 配置**（openclaw.json）：

```json
"plugins": { "entries": { "acpx": { "config": {
  "permissionMode": "approve-all",          // ACP 权限请求自动批准（manifest 标记 dangerousFlag）
  "nonInteractivePermissions": "deny"       // 非交互场景（后台/无 UI）→ 直接拒绝
}}}}
```

`nonInteractivePermissions` 枚举只有 `"deny" | "fail"`，**没有自动放行选项**（设计如此）。

**coding-tool**：`coding` 工具不走 ACP，用自己的 opencode worker（`coding-tool/src/opencode.ts` + `opencode-worker.js`）。执行中 worker 提问 → `question-broker.ts` 挂起等人回答 → **subagent 无人应答 → 卡到 idleTimeout（默认 600s）**。

> 注意：coding worker **内部**的写文件/跑命令发生在 worker 进程里，不经过 OpenClaw 的 before_tool_call 钩子。subagent 里 coding 失败的两点原因：外层工具调用被 dynamic-workflows 拦 + 内部提问无人应答。

---

## 5. 各插件修改方案

### 5.0 通用前提

1. **gateway 从 worktree 加载插件**（`plugins.load.paths` 指向 `.worktrees/autopilot-noop/resources/...`）——热修都改 worktree 里的文件
2. **改完必须 `openclaw gateway restart`**（插件代码与规则在进程启动时加载进内存）
3. **热修会被重新部署覆盖**（`pnpm build:plugins` / `install-omm-plugin.js` 会删掉 `resources/claw-plugin/<name>` 重建）——验证通过后按"正规修法"固化

### 5.1 `@oh-my-matrix/permission-policy`（核心改动，优先做）

**为什么是它**：dynamic-workflows 和 autopilot 都调它的 `classifyCommand`，改一处两个消费方同时受益。

**热修文件（两份，内容相同，都改）**：

```
resources/claw-plugin/dynamic-workflows/node_modules/@oh-my-matrix/permission-policy/dist/src/permission-policy.js
resources/claw-plugin/autopilot/node_modules/@oh-my-matrix/permission-policy/dist/src/permission-policy.js
```

**改动点**（行号基于 0.1.4 dist）：

```js
// ① L374-376 网络工具区块，原：
if (toolLower === 'curl' || toolLower === 'wget')
    return 'network';
// 改为：
if (['curl', 'wget', 'web_fetch', 'web_search', 'browser'].includes(toolLower))
    return 'network';
// （browser 归 network = 全放行浏览器自动化，audit 插件的 URL 规则还在兜底；
//   保守做法是把 browser 拿掉单独评估。）

// ② L395-397 workspace 写工具，原：
const workspaceWriteTools = [
    'write_file', 'apply_patch', 'apply_diff', 'code_editor',
];
// 改为（修掉 OpenClaw 工具名对不上的 bug + 放行 coding 委派工具）：
const workspaceWriteTools = [
    'write_file', 'apply_patch', 'apply_diff', 'code_editor',
    'write', 'edit', 'coding',
];

// ③ 解释器命令（新增，放在包管理器区块之后）。
//    注意：不能归 validation（见原码 B1 注释，validation 无条件放行会绕过
//    defaultDeny，等于拆 guard）。归 network 语义是"允许但留审计"：
if (['python', 'python3', 'node', 'pip', 'pip3', 'uv'].includes(toolLower))
    return 'network';
```

**正规修法**：源码在独立仓库 `github.com/TeFuirnever/oh-my-matrix` 的 `packages/permission-policy`（MatrixAssistant 根 `package.json` 中为版本依赖 `"@oh-my-matrix/permission-policy": "0.1.4"`）：

- 能改上游：在 oh-my-matrix 仓库改 `src/permission-policy.ts` 对应位置，升版本发布，MatrixAssistant 升级依赖后 `pnpm build:autopilot-plugin && pnpm build:dynamic-workflows-plugin` 重新部署
- 改不了上游：`pnpm patch @oh-my-matrix/permission-policy`（或 patch-package）把 diff 固化为补丁
- 改完在 `tests/unit/permission-policy-classifier.test.ts` 补上新工具名的分类断言

### 5.2 `matrixassistant-audit`（放行 web_search）

**热修文件**：`resources/claw-plugin/matrixassistant-audit/dist/src/rules/audit-config.json`

```json
// L103-106，原：
"blacklist": {
  "ruleIds": ["R1","R2","R3","R4","R22","R40","R41","R42","R43","R44","R52","WEB_SEARCH_DISABLED"],
  "tools": ["web_search"]
}
// 改为（工具黑名单和规则黑名单各拦一道，两处都要动）：
"blacklist": {
  "ruleIds": ["R1","R2","R3","R4","R22","R40","R41","R42","R43","R44","R52"],
  "tools": []
}
```

> R1-R52 是 `rm -rf /`、`format c:` 级别的毁灭性命令，**保留别动**。
> `WEB_SEARCH_DISABLED` 规则本体（`audit-rules.json:1632-1647`）留着无害——不在黑名单就不会自动拦，只走确认弹框。

**正规修法**：改源码 `openclaw-extensions/matrixassistant-audit/src/rules/audit-config.json`（worktree 里同样有）→ `pnpm build:audit-plugin` 重新构建部署。

**需要想清楚的安全边界**：确认弹框超时无人应答 = high/critical 自动拦截。subagent/无人值守时，命中 high 规则的调用（敏感路径、敏感关键词 URL）实际全灭。如果 subagent 需要碰 `.env`、内网 URL，要么调 `sensitivePaths.paths` / `networkSecurity.suspiciousDomains`，要么接受这个边界（**建议接受**）。

### 5.3 `dynamic-workflows`（可不动，或加配置化白名单）

permission-policy 修好后此插件**本体可以不动**。若想长期灵活控制（不用每次改上游包），建议加配置项（源码在 oh-my-matrix 仓库 `packages/dynamic-workflows`）：

```js
// dist/index.js 的 on('before_tool_call', ...) 里，decidePermissionForEvent 之前：
const extraAllow = Array.isArray(config.subagentExtraAllowTools)
    ? config.subagentExtraAllowTools.map(t => String(t).toLowerCase())
    : [];
if (extraAllow.includes(String(event.toolName).toLowerCase())) {
    return; // 放行
}
```

同时在 `openclaw.plugin.json` 的 `configSchema.properties` 加：

```json
"subagentExtraAllowTools": { "type": "array", "items": { "type": "string" } }
```

之后在 openclaw.json 里即可按需放行：

```json
"plugins": { "entries": { "dynamic-workflows": {
  "enabled": true,
  "config": { "subagentExtraAllowTools": ["web_fetch", "web_search", "coding"] }
}}}
```

> **如果只能改一处**，推荐做这个（加上 permission-policy 的 ② 修 write/edit bug）——保留 rm/destructive git/sudo 的防线，只放行指定工具。

### 5.4 `coding-tool`（subagent 里跑编码任务的提问问题）

源码就在 `resources/claw-plugin/coding-tool/src/`（fork 自有插件，直接改）：

- 在 `tool.ts` 处理 question 的地方（`buildQuestionProgressView` 附近，L249+）加 subagent 会话检测：`sessionKey.includes(':subagent:')` 时自动选默认答案或直接拒绝问题，让 worker 继续或快速失败，**不要挂着等**
- 或 spawn worker 时传"免问"指令（取决于 opencode worker 的问题协议是否支持自动应答，需看 `src/opencode-worker.js` 的问题处理逻辑细化）

### 5.5 `acpx` / ACP 配置

现状 `permissionMode: "approve-all"` + `nonInteractivePermissions: "deny"`。枚举只有 `deny | fail`，没有自动放行选项（设计如此）：

- `deny`（默认）：被拒操作跳过，会话继续
- `fail`：整个 turn 失败，快速暴露问题

无配置可解的自动放行；若 subagent 走 ACP 会话仍被拒，评估是否可接受现状。注意 `coding` 工具不经 ACP（见 4.5）。

### 5.6 不需要改的插件

| 插件 | 结论 |
|---|---|
| autopilot | trusted 黑名单模式合理；permission-policy 修好后自动受益（分类更准），本体不动 |
| agent-state-forwarder / trace-bridge / llm-session-injector / acp-bridge / git-ai | 纯观察/注入，无 block 逻辑 |
| mcc-persona-toolkit / sdd-workflow-tool / register-gateway-method / archive-restore / memory-core / browser / open-prose / matrix-context-controller | 工具提供方或服务型，无工具拦截 |

### 5.7 openclaw.json 侧的说明（背景）

- `tools.profile: "coding"` + `tools.alsoAllow`/`tools.deny` 当前配置**没有问题**，不是瓶颈
- `tools.alsoAllow` 里的 `message`/`agents_list` 对 subagent 无效：这两个在 openclaw 硬 deny 名单里，只能用 `tools.subagents.tools.alsoAllow` 覆盖（`src/agents/agent-tools.policy.ts:100-111`，subagent 层的 allow/alsoAllow 可覆盖内置 deny）
- **不建议**用 `plugins.entries.dynamic-workflows.enabled: false` 换取全放行——会同时拆掉 subagent 对 rm/destructive git/sudo 的防线

---

## 6. 一次 subagent `web_fetch` 调用的完整拦截链示例

```
模型调用 web_fetch
 → ① openclaw 工具策略管线：coding profile 含 web_fetch → 放行 ✓
 → ② before_tool_call 钩子（按 priority）：
    1. dynamic-workflows (11)：sessionKey 含 :subagent: → 分类器不认识 web_fetch
       → BLOCK "not on the allowlist for subagent sessions" ✗  ← 死在这里
    （若放行，接下来）
    2. autopilot (10)：仅 autopilot run 生效
    3. matrixassistant-audit：web_fetch 的 URL 访问 medium/high → 仅记录放行
 → ③ 工具执行（永远到不了）
```

---

## 7. 建议执行顺序

| 步骤 | 动作 | 耗时 |
|---|---|---|
| 1 | 热修 permission-policy 两份 dist（5.1 的 ①②③） | 5 分钟 |
| 2 | `openclaw gateway restart` | — |
| 3 | spawn 一个 subagent 测 `web_fetch` / `write`，确认不再出现 `before_tool_call BLOCKED (subagent guard)` | 2 分钟 |
| 4 | 热修 audit-config.json 放行 web_search（5.2）→ 重启 → 验证 | 5 分钟 |
| 5 | subagent 里跑一次 coding 任务；若卡提问 → 改 coding-tool（5.4） | 视情况 |
| 6 | **正规化**：audit 走源码 + `pnpm build:audit-plugin`；permission-policy 走 pnpm patch 或上游 PR；dynamic-workflows 加 `subagentExtraAllowTools` 配置项 | 半天内 |
| 7 | 补测试：`tests/unit/permission-policy-classifier.test.ts` 加新分类断言 | — |

**验证手段**：

- 网关日志搜 `before_tool_call BLOCKED (subagent guard)`（dynamic-workflows）
- 网关日志搜 `[Audit]` 前缀条目（matrixassistant-audit，含 ruleId）
- 会话记录中 toolResult 的 `details.deniedReason`：`plugin-before-tool-call` = 插件拦截；无此字段且正常执行 = 通过

---

## 8. 附录

### 8.1 关键文件路径速查

| 用途 | 路径（相对 `C:/Users/admin/Documents/Codes/bug-fix/MatrixAssistant/`） |
|---|---|
| 网关配置 | `~/.openclaw/openclaw.json` |
| 部署的 dynamic-workflows | `.worktrees/autopilot-noop/resources/claw-plugin/dynamic-workflows/dist/index.js` |
| 部署的 autopilot | `.worktrees/autopilot-noop/resources/claw-plugin/autopilot/dist/index.js` |
| permission-policy（dynamic-workflows 内） | `.worktrees/autopilot-noop/resources/claw-plugin/dynamic-workflows/node_modules/@oh-my-matrix/permission-policy/dist/src/permission-policy.js` |
| permission-policy（autopilot 内） | `.worktrees/autopilot-noop/resources/claw-plugin/autopilot/node_modules/@oh-my-matrix/permission-policy/dist/src/permission-policy.js` |
| 部署的 audit 配置（热修点） | `.worktrees/autopilot-noop/resources/claw-plugin/matrixassistant-audit/dist/src/rules/audit-config.json` |
| audit 源码 | `openclaw-extensions/matrixassistant-audit/src/`（worktree 内同路径存在） |
| audit 规则库 | `.../matrixassistant-audit/dist/src/rules/audit-rules.json`（91 条） |
| coding-tool 源码 | `.worktrees/autopilot-noop/resources/claw-plugin/coding-tool/src/` |
| 会话记录 | `~/.openclaw/agents/<agentId>/sessions/sessions.json` + `<sessionId>.jsonl` |
| OpenClaw 核心 subagent 策略 | openclaw 仓库 `src/agents/agent-tools.policy.ts:50-74` |
| OpenClaw 工具管线 | openclaw 仓库 `src/agents/agent-tools.ts:1101-1145` |
| 官方 subagent 文档 | https://docs.openclaw.ai/tools/subagents |

### 8.2 版本对应关系

- 运行网关版本：`2026.7.1-2`（openclaw 仓库有对应 tag `v2026.7.1-2`，本仓库 HEAD 同代）
- `@oh-my-matrix/autopilot` 4.4.1（源仓库 `github.com/TeFuirnever/oh-my-matrix` packages/autopilot）
- `@oh-my-matrix/dynamic-workflows` 1.2.0（同上）
- `@oh-my-matrix/permission-policy` 0.1.4（同上；root node_modules 与两个部署副本各一份）

### 8.3 安全边界备忘（改动后仍然保留的防线）

- permission-policy 无条件拦截：`credential_access`、`system_write`（sudo/format/diskpart/reg 等）
- `workspace_cleanup`（rm/del/erase/rd）、`destructive_git`（reset --hard/push --force 等）在 subagent 与 autopilot 中均拦
- matrixassistant-audit 的 R1-R52 毁灭性命令黑名单
- 确认弹框机制（medium/high/critical 需桌面端确认，超时 high 以上自动拦）
- openclaw 核心 subagent deny（gateway/cron/sessions_send/message 等）

放开的是"工具可用性"，不是"无审计"——`network` 类与 audit 层均留审计记录。
