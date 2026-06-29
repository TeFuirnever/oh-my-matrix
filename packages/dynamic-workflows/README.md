# @openclaw/dynamic-workflows

OpenClaw plugin providing the **subagent runtime guard** — blocks destructive
operations (destructive git, file cleanup, credential access, shell substitution,
wrapper-exec) for `:subagent:` sessions. Also re-exports the permission-policy
library API consumed by [`@openclaw/autopilot`](../autopilot).

Part of the [oh-my-matrix](https://github.com/TeFuirnever/oh-my-matrix) runtime stack.

## Install

```bash
npm install @openclaw/dynamic-workflows
# peer dependencies
npm install openclaw@">=2026.5.28" @openclaw/permission-policy
```

## Use

Registers `before_tool_call` at **priority 11** — runs before autopilot (priority 10)
and the audit plugin (9), short-circuiting with `block` on destructive ops for
`:subagent:` sessions. Main-session autopilot runs are unaffected.

**Fail-closed:** `:subagent:` sessions default-deny when the guard can't classify a
command.

## Status

v0.1.0. Tested with `vitest`. See the project
[changelog](https://github.com/TeFuirnever/oh-my-matrix/blob/master/CHANGELOG.md).
