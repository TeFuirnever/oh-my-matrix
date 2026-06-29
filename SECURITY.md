# Security Policy

## Supported Scope

This repository is WIP. Security support applies to the current `master` branch only.

Covered:

- `packages/autopilot/`
- `packages/dynamic-workflows/`
- `packages/permission-policy/`
- `skill/dynamic-workflows/`
- packaging/deployment docs that affect host runtime safety

Archived v0.x records under `docs/archive/` are historical and not supported as live software.

## Reporting a Vulnerability

Do not file public issues for security vulnerabilities.

Report privately by email to **504897664@qq.com** or through GitHub private vulnerability reporting if enabled. Include:

- affected package/path
- reproduction steps
- expected impact
- whether the issue affects source tests, packaged dist, or deployed host behavior

Expected response target: acknowledgement within 48 hours.

## Current Security Model

omm treats workflow subagents as untrusted.

- `@oh-my-matrix/dynamic-workflows` registers `before_tool_call` priority 11 for `:subagent:` sessions.
- `@oh-my-matrix/permission-policy` classifies commands and returns permission decisions.
- Subagent sessions use fail-closed defaults.
- Audit entries are persisted under `.autopilot/`.

Blocked classes include destructive git, workspace cleanup, credential access, system writes, shell substitution, process substitution, and wrapper exec.

## Known Limitations

The current command handling is tokenize-based, not a full shell parser. Known limitations include redirect writes, unknown non-shell framework tools, and quoted operator false positives.

See [`docs/fixes/runtime-guard-event-shape.md`](docs/fixes/runtime-guard-event-shape.md) for the current limitation record.

## Maintainer Checks

```bash
pnpm --filter @oh-my-matrix/autopilot test
pnpm --filter @oh-my-matrix/dynamic-workflows test
pnpm --filter @oh-my-matrix/permission-policy test
pnpm audit
```
