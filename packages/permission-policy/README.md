# @openclaw/permission-policy

Shared permission-policy primitives consumed by
[`@openclaw/autopilot`](../autopilot) and
[`@openclaw/dynamic-workflows`](../dynamic-workflows). A **pure, stateless library**
(platform-level) — not an OpenClaw plugin.

Part of the [oh-my-matrix](https://github.com/TeFuirnever/oh-my-matrix) runtime stack.

## Install

```bash
npm install @openclaw/permission-policy
```

## What it provides

- **Permission decision** — `decidePermissionForEvent(event)` decides permit/deny for a
  tool call; `classifyCommand` / `extractCommandSegments` map a command to a
  `CommandClass` (read / write / destructive / network / …).
- **Audit** — `appendAuditEntry(...)` / `loadRecentAuditEntries(...)` append-only log.

Designed **fail-closed** for `:subagent:` destructive operations.

## Status

v0.1.0. Tested with `vitest`. See the project
[changelog](https://github.com/TeFuirnever/oh-my-matrix/blob/master/CHANGELOG.md).
