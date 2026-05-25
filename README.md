# omm (oh-my-matrix)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![pnpm 10+](https://img.shields.io/badge/pnpm-10%2B-orange.svg)](https://pnpm.io/)

OpenClaw-native orchestration extension suite.

## What's included

| Package            | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| **omm-plugin**     | OpenClaw plugin — `omm_ping`, `omm_cancel`, state tools, agent-prompt tools, session lifecycle hooks |
| **omm-skills**     | 5 core skills (ralph/autopilot/team/ping/cancel) shipped; 9 extended skills parked for future restore |
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
| `pnpm omm:openclaw-seed`     | Dry-run seed for `~/.openclaw/openclaw.json` plugin registration |
| `pnpm omm:ma-seed`           | Dry-run seed for MatrixAssistant MCP registry entries            |

## Consumer integration

This repo produces `omm-dist/omm-suite-<version>.tgz` containing the compiled plugin,
MCP server, and skill definitions. After unpacking the suite, run the bundled
seeders in dry-run mode first, then pass `--write` when the target config is correct:

```bash
node <omm-suite>/omm-scripts/omm-openclaw-seed.mjs --omm-root <omm-suite> --layout suite
node <omm-suite>/omm-scripts/omm-openclaw-seed.mjs --omm-root <omm-suite> --layout suite --write
```

`omm-openclaw-seed.mjs` adds `omm` to `plugins.allow`, appends the suite plugin
directory to `plugins.load.paths`, and creates `plugins.entries.omm` in
`~/.openclaw/openclaw.json` so OpenClaw discovers the plugin and bundled skills.
For MatrixAssistant's separate MCP registry, use `omm-ma-seed.mjs`; see
[`docs/contracts/ma-integration-snippets.md`](docs/contracts/ma-integration-snippets.md).

## License

See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow, and code style.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
