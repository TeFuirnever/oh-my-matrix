#!/usr/bin/env node
/**
 * MCP inline-source hygiene guard.
 *
 * ADR-006 introduced build-time inline generation, but a failed generator pass
 * can leave partial generated fragments in committed TypeScript sources. This
 * script is intentionally conservative: it removes only known generated
 * fragments and standalone `null` sentinel lines, then reports whether the MCP
 * sources are clean. It never attempts broad source rewriting.
 *
 * Usage:
 *   node omm-scripts/generate-mcp-inlines.mjs
 *   node omm-scripts/generate-mcp-inlines.mjs --check
 */
import { scanInlineSources } from "./mcp-inline-hygiene.mjs";

async function main() {
  const checkOnly = process.argv.includes("--check");
  const ok = await scanInlineSources({ write: !checkOnly });

  if (!ok) {
    console.error(
      "MCP sources contain failed generated fragments. Run `pnpm omm:generate-inlines`.",
    );
    process.exit(1);
  }
}

await main();
