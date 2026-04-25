# omm (oh-my-matrix)

OpenClaw-native orchestration extension suite.

## What's included

- **omm-plugin** — OpenClaw plugin providing `omm_ping` and `omm_cancel` tools, plus session lifecycle hooks
- **omm-mcp** — MCP state server exposing omm state read/write over stdio JSON-RPC
- **omm-skills** — Skill definitions (`omm-ping`, `omm-cancel`, `omm-ralph`, `omm-autopilot`, `omm-team`)
- **omm-scripts** — Build, verification, and compliance toolchain

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
