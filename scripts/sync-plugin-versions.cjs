#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Post-version sync: after `changeset version` bumps package.json versions,
 * propagate each package's version into every place that must mirror it:
 *   - openclaw.plugin.json (if present)
 *   - index.ts `export const version = '...'` (if present)
 *
 * Wired into the `version-packages` script:
 *   "version-packages": "changeset version && node scripts/sync-plugin-versions.js"
 *
 * Without this, every Version Packages PR needs a manual plugin.json + index.ts
 * bump (the invariant is enforced by publish.sh's pre-flight check). The index.ts
 * sync was added after S14 drift recurred: a hand-edited `export const version`
 * fell 3 patches behind package.json and shipped a wrong runtime version export.
 */
const fs = require('node:fs');
const path = require('node:path');

const packagesDir = path.resolve(__dirname, '..', 'packages');

let updated = 0;
for (const pkgName of fs.readdirSync(packagesDir)) {
  const pkgJsonPath = path.join(packagesDir, pkgName, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  // 1. openclaw.plugin.json
  const pluginJsonPath = path.join(packagesDir, pkgName, 'openclaw.plugin.json');
  if (fs.existsSync(pluginJsonPath)) {
    const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
    if (pkg.version !== plugin.version) {
      plugin.version = pkg.version;
      fs.writeFileSync(pluginJsonPath, JSON.stringify(plugin, null, 2) + '\n');
      console.log(`  synced ${pkgName}/openclaw.plugin.json -> ${pkg.version}`);
      updated++;
    }
  }

  // 2. index.ts `export const version = '...'`
  const indexTsPath = path.join(packagesDir, pkgName, 'index.ts');
  if (fs.existsSync(indexTsPath)) {
    const src = fs.readFileSync(indexTsPath, 'utf-8');
    // Match `export const version = '<v>';` (single quotes, semicolon, any indent).
    const re = /(export\s+const\s+version\s*=\s*')([^']*)('\s*;)/;
    const m = src.match(re);
    if (m && m[2] !== pkg.version) {
      const next = src.replace(re, `$1${pkg.version}$3`);
      fs.writeFileSync(indexTsPath, next);
      console.log(`  synced ${pkgName}/index.ts version const -> ${pkg.version}`);
      updated++;
    }
  }
}

if (updated === 0) {
  console.log('  all plugin.json + index.ts versions already in sync');
} else {
  console.log(`  ${updated} file(s) synced`);
}
