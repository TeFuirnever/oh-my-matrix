#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Post-version sync: after `changeset version` bumps package.json versions,
 * copy each package's version into its openclaw.plugin.json (if present) so
 * the two files never drift.
 *
 * Wired into the `version-packages` script:
 *   "version-packages": "changeset version && node scripts/sync-plugin-versions.js"
 *
 * Without this, every Version Packages PR needs a manual plugin.json bump
 * (the invariant is enforced by publish.sh's pre-flight check).
 */
const fs = require('node:fs');
const path = require('node:path');

const packagesDir = path.resolve(__dirname, '..', 'packages');

let updated = 0;
for (const pkgName of fs.readdirSync(packagesDir)) {
  const pkgJsonPath = path.join(packagesDir, pkgName, 'package.json');
  const pluginJsonPath = path.join(packagesDir, pkgName, 'openclaw.plugin.json');
  if (!fs.existsSync(pkgJsonPath) || !fs.existsSync(pluginJsonPath)) continue;

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));

  if (pkg.version !== plugin.version) {
    plugin.version = pkg.version;
    fs.writeFileSync(pluginJsonPath, JSON.stringify(plugin, null, 2) + '\n');
    console.log(`  synced ${pkgName}/openclaw.plugin.json -> ${pkg.version}`);
    updated++;
  }
}

if (updated === 0) {
  console.log('  all plugin.json versions already in sync');
} else {
  console.log(`  ${updated} plugin.json file(s) synced`);
}
