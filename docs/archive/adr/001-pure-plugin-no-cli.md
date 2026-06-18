# ADR-001: Pure OpenClaw Plugin, No CLI

## Context

The reference project oh-my-codex ships a standalone CLI binary (`omx`) with 20+ subcommands, plus 4 Rust native crates for file exploration, shell detection, and runtime management. This architecture suits a project that runs independently alongside a host CLI.

omm targets the OpenClaw Gateway（OpenClaw 网关）, which loads plugins directly via a `register(api)` entry point and dispatches tool calls and skill execution through its own runtime. In this environment, a standalone binary would be redundant — all functionality is accessed through the Gateway's plugin and skill mechanisms.

## Decision

omm is a pure OpenClaw plugin with no standalone binary and no Rust native modules.

- All tools are registered via `api.registerTool()` in the plugin entry point
- All skills are defined as SKILL.md files interpreted by the Gateway's skill runtime
- The MCP server runs as a separate stdio process but is not a user-facing CLI
- Distribution is a single JS-only tarball (`omm-suite-<version>.tgz`)

## Consequences

**Positive:**

- Simpler build: TypeScript only, no Rust toolchain, no cross-compilation
- Smaller distribution: single tarball vs npm binary + native addons
- Fewer moving parts: no process management, no PATH configuration
- Natural fit: the Gateway already provides tool dispatch and skill execution

**Negative:**

- No independent testability outside an OpenClaw environment — integration testing requires a Gateway or mock
- No standalone CLI for ad-hoc debugging — must use MCP server or plugin test harness
- Dependent on OpenClaw Plugin ABI stability — ABI changes require omm updates

**Trade-off accepted:** omm sacrifices standalone operation for tighter Gateway integration and simpler distribution. This is appropriate because omm's value proposition is extending an existing OpenClaw environment, not running independently.
