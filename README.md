# omm (oh-my-matrix)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![pnpm 10+](https://img.shields.io/badge/pnpm-10%2B-orange.svg)](https://pnpm.io/)

OpenClaw-native orchestration extension suite.

## What's included

| Package            | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| **omm-plugin**     | OpenClaw plugin — `omm_ping`, `omm_cancel`, state tools, agent-prompt tools, session lifecycle hooks |
| **omm-mcp**        | MCP state server — stdio JSON-RPC exposing state read/write/list                                     |
| **omm-mcp-memory** | MCP memory server — key-value store over `stateRoot/memory/`                                         |
| **omm-mcp-trace**  | MCP trace server — append-only JSONL execution event log with metrics                                |

## Quick start

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Scripts

| Script                       | Description                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| `pnpm build`                 | Compile all packages and build `omm-suite-<version>.tgz`         |
| `pnpm omm:scan-names`        | Scan source files for forbidden naming using hash-based denylist |
| `pnpm omm:verify-bundle`     | Verify the suite tarball against its embedded manifest           |
| `pnpm omm:verify-provenance` | Verify `omm-provenance.json` entries reference real files        |

## Consumer integration

This repo produces `omm-dist/omm-suite-<version>.tgz` containing the compiled plugin,
MCP server, and skill definitions. MatrixAssistant consumes it via
`node scripts/omm-bundle.mjs <path-to-tgz>`, which unpacks and verifies the bundle
into the `resources/` directory. At startup, `omm-openclaw-seed.ts` merges omm config
entries into `openclaw.json` so OpenClaw discovers the plugin and skills.

## License

See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow, and code style.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
