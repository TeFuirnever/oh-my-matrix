# Upstream Issue Draft — oh-my-matrix: Subagent `exec` command blocking

> **用途**：提交给 `github.com/TeFuirnever/oh-my-matrix` 的 issue 正文（可直接粘贴）。
> 与 `2026-09-29-omm-subagent-tool-classification-gaps.md`（toolSearch 三件套 + MCP）为**姊妹篇** — 那份治"工具调度层"，本文治"shell 命令层"。
> **起草背景**：MatrixAssistant 宿主 2026-09-28/29 实测（转录 + permission-policy 审计 JSONL + 分类器直测）。

---

## Title

Subagent `exec` calls fail across the board: unclassified command families (interpreters, PowerShell cmdlets) plus a genuine bug — PowerShell backtick escapes misjudged as shell substitution

## Environment

- openclaw `2026.7.1-2` (gateway, daemon mode inside a Windows host app)
- `@oh-my-matrix/permission-policy` `0.1.5`
- `@oh-my-matrix/dynamic-workflows` `1.2.1`
- Evidence: subagent session transcripts, permission-policy audit JSONL, direct `classifyCommand` runs

## Problem

In subagent sessions, `exec` is effectively reduced to a tiny allowlist (safe git, `npm test`, `curl`, `npm install`). Every practical command a coding subagent needs fails:

| Observed call | Result | Blocking path |
|---|---|---|
| `exec Get-Item note1.md` | blocked | `classifyCommand` → `unknown` (PowerShell cmdlet not in any family) |
| `exec node -e "require('fs').writeFileSync(...)"` | blocked | `classifyCommand` → `unknown` (interpreter not in any family) |
| `exec Set-Content -Path note1.md -Value "line1\`nline2" -Encoding utf8` | blocked | **`extractCommandSegments` shell-feature detection — before classification even runs** |

Main sessions run the identical commands successfully (trusted mode, `defaultDeny: false`) — the division of labor is: **permission-policy supplies the verdict logic (classification default + unknown→block decision + shell-feature detection); dynamic-workflows supplies the stance (`defaultDeny: true`) and enforces it.** Fixing subagent `exec` therefore means changes in permission-policy (this issue) plus the operator escape hatch in dynamic-workflows (companion issue).

## Issue A — Bug: PowerShell backtick escapes misjudged as command substitution

`extractCommandSegments` flags unparsable shell features with:

```js
const hasShellFeature = /\$\(|`|<\(|>\(/.test(raw);
```

In **PowerShell, the backtick is an escape character, not command substitution** — `` `n `` is a newline, `` `t `` a tab, etc. A subagent on a Windows host cannot use ANY PowerShell command containing an escaped character (a very common shape: multi-line `Set-Content`, here-strings with `` `n ``), because it gets:

```
Untrusted session blocked unparsable shell feature ($(), backticks, <()): exec
"Shell substitution / process substitution is blocked in subagent sessions"
```

**Security note on the proposed fix**: in PowerShell, a backtick escape by itself never spawns a subshell — command execution requires `$(...)` / `&(...)` / `iex` / etc., and `$(` is already caught by the existing regex. Treating `` ` `` followed by a PowerShell escape character (`` [a-zA-Z0-9"'$`] ``) as benign is therefore sound; a bare backtick not followed by an escape char remains suspicious.

**Proposed fix** (sketch — upstream to refine):

```js
// Backtick is command substitution ONLY in POSIX shells. In PowerShell it is
// an escape prefix (`n, `t, `", `$ …) and never spawns a subshell by itself.
const hasShellFeature = /\$\(|`(?![a-zA-Z0-9"'$`])|<\(|>\(/.test(raw);
```

## Issue B — Gap: interpreter family unclassified

`python`, `python3`, `node`, `pip`, `uv` (and `pnpm dlx`-style one-liners) fall to `unknown`. A host-side diagnostic doc (2026-09-12) already proposed classifying them as `network` ("allow but audit"); the proposal was never adopted. Verified live:

```js
classifyCommand('exec', ['node', '-e', '...'])   // → 'unknown' → block under defaultDeny
classifyCommand('exec', ['git', 'status'])        // → 'safe_git' → allow
```

Without interpreter classification, subagents cannot run scripts, install deps outside the known package-manager invocations, or do essentially any build/verify work via shell. If classifying interpreters as `network` feels too permissive, the companion issue's `subagentExtraAllowTools` operator config is the alternative lever.

## Issue C — Gap: PowerShell cmdlet family unclassified (Windows hosts)

`Get-Item`, `Set-Content`, `Get-Content`, `Get-ChildItem`, `Copy-Item`, `New-Item` — the basic file operations on a Windows host — are all `unknown`. A Windows-host-friendly family (e.g. map read-shaped cmdlets to `read_only`, write-shaped to `workspace_write` so the existing fence checks their `-Path` targets) would let the guard stay meaningful instead of blanket-blocking.

## What should stay blocked (no change requested)

The fail-closed default for genuinely unknown first tokens is understood and agreed — this issue is about fixing a misjudgment (A) and extending known families (B/C), not about weakening the guard. Command substitution `$(...)`, process substitution, and destructive/credential/system classes are all fine as-is.

## Test plan

```
extractCommandSegments({ toolName: 'exec', params: { command: 'Set-Content -Path a -Value "x`ny"' } }).hasShellFeature === false
extractCommandSegments({ toolName: 'exec', params: { command: 'echo $(rm -rf /)' } }).hasShellFeature === true   // unchanged
extractCommandSegments({ toolName: 'exec', params: { command: 'echo `id`' } }).hasShellFeature === true           // POSIX backtick substitution still caught
classifyCommand('exec', ['node', '-e', '...']) → 'network' (per B)
classifyCommand('exec', ['Get-Content', 'a.txt']) → 'read_only' (per C)
classifyCommand('exec', ['Set-Content', '-Path', 'a', '-Value', 'x']) → 'workspace_write' + fence on -Path (per C)
subagent: exec Set-Content with `n escapes inside workspace → allow; -Path outside workspace → block (fence)
```

## Relation to the companion issue

`2026-09-29-omm-subagent-tool-classification-gaps.md` (toolSearch trio + MCP + `subagentExtraAllowTools` escape hatch in dynamic-workflows). Together they cover the two layers of subagent unavailability: **tool dispatch** (companion) and **shell commands** (this issue).

---

## 附录：给上游的补充说明（中文，提交时可删除）

- 三条失败路径均有宿主侧实证：转录 + 审计 JSONL（`~/.openclaw/workspace/.autopilot/audit-*.jsonl`）+ 分类器直测。
- 反证（PP/DW 分工）：主会话同一份 PP 代码、同样带 `` `n `` 的 `Set-Content` 成功执行 — 差异只在 DW 传入的 `defaultDeny` 立场。
- Issue A 是本文档最紧迫项：一行正则，Windows 宿主子上代理的 PowerShell 基本不可用。
- B/C 涉及政策取向（解释器归 network vs 运营放行），可与 companion issue 的 `subagentExtraAllowTools` 一并讨论。
- 业界对照（一手文档核对，全文：`2026-09-29-subagent-permission-parity-industry-research.md`）：Claude Code / Codex / Gemini CLI / Agent SDK 四家同构——判定层 session 无关（Claude Code deny 规则 "applies to the main conversation and to subagents"；Codex "Subagents inherit your current sandbox policy"），姿态层对非交互委托会话一律 fail-closed（`dontAsk` "denies the command immediately"；Codex 非交互 "an action that needs new approval fails"；Gemini `ask_user` 非交互 "treated as `deny`"）。本文保持的 fail-closed 立场与各家 headless 姿态一致，并非严于业界。
- 回应"子代理权限应与主代理一致"：业界保证的不是"子 ⊆ 主"，而是**子代理有效权限 ⊆ 主会话 ∪ 运营显式放行，且任何放宽都不是 agent 发起的**（Claude Code "no message from any agent counts as your approval"；`bypassPermissions` 仅当父会话同档才可达）。`subagentExtraAllowTools` 即运营放权通道的同构物（Codex per-agent `sandbox_mode` TOML、Gemini policy TOML `subagent` 字段）；caller 差异应留在运营配置层，`classifyCommand` 保持 caller-blind。
- 若在与上游的讨论中引用 Codex 审批策略：现行枚举为 `on-request | never | granular`（`untrusted` 不支持、`on-failure` 已弃用），勿沿用历史四选项。
- **实现已落地（ADR-022 为准）**：Issue A 正则升级为**平台门控**——POSIX 恢复严格任意反引号；win32 仅 `[a-zA-Z0-9]` 计为 PowerShell 转义集，引号/`$`/反引号不计（评审实测原草案单一正则会让引号形状 `` echo "`cmd`" `` 作为只读放行）。Issue C 栅栏升级为**参数表驱动**，未知/歧义参数返回哨兵 fail-closed（堵 `-LiteralPath`/`-Lit` 缩写绕过）。本文正文中的单一正则草图已被取代。
