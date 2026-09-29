# @oh-my-matrix/dynamic-workflows

OpenClaw plugin providing the **subagent runtime guard** — blocks destructive
operations (destructive git, file cleanup, credential access, shell substitution,
wrapper-exec) for `:subagent:` sessions. Imports permission primitives from
[`@oh-my-matrix/permission-policy`](../permission-policy).

Part of the [oh-my-matrix](https://github.com/TeFuirnever/oh-my-matrix) runtime stack.

## Install

```bash
npm install @oh-my-matrix/dynamic-workflows
# peer dependencies
npm install openclaw@">=2026.7.1-2" @oh-my-matrix/permission-policy
```

## Use

Registers `before_tool_call` at **priority 11** — runs before autopilot (priority 10)
and the audit plugin (9), short-circuiting with `block` on destructive ops for
`:subagent:` sessions. Main-session autopilot runs are unaffected.

**Fail-closed:** `:subagent:` sessions default-deny when the guard can't classify a
command.

## Configuration (pluginConfig)

| Key | Effect |
|---|---|
| `enabled` | `false` disables the guard (loud log; subagents run unguarded). |
| `highRiskTools` | Tool names blocked for subagents even if classification would allow them. |
| `subagentExtraAllowTools` | **Operator expansion lever** (ADR-022 companion): tool names granted to subagent sessions despite the fail-closed default — for host tools the classifier leaves unclassified (browser, nodes, …). Additive only; every grant is audited as an `allow`. Guard-disarming names (`exec`/`bash`/… and `write`/`edit`/`apply_patch`/…) are refused at register with an error log: granting them would bypass command classification / the write fence wholesale. Use classifier families (ADR-022) or workspace assignment instead. When `highRiskTools` and this key carry the same name, the block wins. |

## Status

v0.1.3. Tested with `vitest`. See the project
[changelog](https://github.com/TeFuirnever/oh-my-matrix/blob/master/CHANGELOG.md).
