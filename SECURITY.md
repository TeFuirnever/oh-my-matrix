# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.3.x   | Yes       |
| < 0.3   | No        |

## Reporting a Vulnerability

**Do not file public issues for security vulnerabilities.**

Please report security vulnerabilities by emailing **504897664@qq.com** or
using GitHub's private vulnerability reporting feature. We will acknowledge
receipt within 48 hours and provide a timeline for a fix.

## Security Practices

oh-my-matrix implements the following security measures:

- **Path-traversal defense**: All state/memory/trace keys are validated against
  a strict allowlist pattern (`^[a-z0-9][a-z0-9_-]{0,63}$/i`)
- **Atomic writes**: State files use tmp+rename to prevent partial writes
- **Cross-process locking**: `O_EXCL`-based file locks prevent concurrent write
  races across plugin and MCP server processes (ADR-005)
- **Workflow exclusivity**: Only one workflow mode (ralph/autopilot/team) can be
  active simultaneously
- **Input size limits**: MCP servers enforce a 1 MiB hard cap per JSON-RPC
  request line
- **Trace rotation**: Sessions over 8 MiB are rotated with a 40 MiB ceiling
- **Zero runtime dependencies**: MCP servers have no npm dependencies (ADR-003),
  minimizing supply-chain attack surface

## Dependency Auditing

```bash
pnpm audit
pnpm omm:verify-provenance
```

## Scope

This policy covers the omm plugin, all MCP servers (omm-mcp, omm-mcp-memory,
omm-mcp-trace), and the build/verification toolchain.
