#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Assert before_tool_call hook priority ordering across packages:
 *   dynamic-workflows priority  >  autopilot priority  >  9  (audit plugin floor)
 *
 * Replaces a GNU-grep-only (`grep -oP`) shell pipeline so the check is portable
 * across CI runners (ubuntu / windows) and local dev on macOS/BSD grep.
 *
 * Fails loudly (exit 1) when a constant is missing or malformed so that a future
 * refactor (e.g. `as const`, computed expression) cannot silently turn this guard
 * into a no-op.
 */
const fs = require('node:fs');
const path = require('node:path');

const PACKAGES_DIR = path.resolve(__dirname, '..', 'packages');
const RE = /BEFORE_TOOL_CALL_PRIORITY\s*=\s*(\d+)/;

/**
 * @param {string} pkgDir
 * @returns {number}
 */
function readPriority(pkgDir) {
  const file = path.join(pkgDir, 'index.ts');
  const src = fs.readFileSync(file, 'utf-8');
  const m = src.match(RE);
  if (!m) {
    console.error(`ERROR: BEFORE_TOOL_CALL_PRIORITY constant not found in ${path.relative(PACKAGES_DIR, pkgDir)}/index.ts`);
    process.exit(1);
  }
  return Number(m[1]);
}

const dw = readPriority(path.join(PACKAGES_DIR, 'dynamic-workflows'));
const ap = readPriority(path.join(PACKAGES_DIR, 'autopilot'));

console.log(`DW priority: ${dw}, Autopilot priority: ${ap}`);

let failed = false;
if (!(dw > ap)) {
  console.error(`ERROR: dynamic-workflows priority (${dw}) must be > autopilot priority (${ap})`);
  failed = true;
}
if (!(ap > 9)) {
  console.error(`ERROR: autopilot priority (${ap}) must be > 9 (audit plugin floor)`);
  failed = true;
}

if (failed) process.exit(1);
