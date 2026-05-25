#!/usr/bin/env node
/**
 * CI drift gate for MCP inline hygiene.
 *
 * The current release chain no longer writes canonical inline copies into MCP
 * TypeScript sources. This verifier keeps the remaining contract narrow: MCP
 * sources must not contain partial generated fragments or standalone `null`
 * sentinels left by failed generator runs.
 */
import { scanInlineSources } from "./mcp-inline-hygiene.mjs";

const ok = await scanInlineSources();

if (!ok) {
  console.error(
    "MCP sources contain failed generated fragments. Run `pnpm omm:generate-inlines`.",
  );
  process.exit(1);
}

console.log("MCP inline sources have no failed generated fragments.");
