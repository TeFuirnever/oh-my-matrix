#!/usr/bin/env bash
# sync-to-ma.sh — refresh MA's @openclaw/dynamic-workflows from this source.
#
# Mirrors packages/autopilot/scripts/sync-to-ma.sh (ADR-010 follow-up #1 pattern).
# Chain: omm build+pack → copy tgz into MA → update MA package.json version ref →
# MA install → MA build:dynamic-workflows-plugin.
#
# Usage: ./sync-to-ma.sh [MA_ROOT]   (default MA_ROOT = ../../MatrixAssistant)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"            # packages/dynamic-workflows
OMM_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
MA_ROOT="${1:-$OMM_ROOT/../MatrixAssistant}"
MA_RES_DIR="$MA_ROOT/resources/dynamic-workflows"

[ -f "$MA_ROOT/package.json" ] || { echo "MA_ROOT not found: $MA_ROOT" >&2; exit 1; }

# 1. build + pack in omm
cd "$PKG_DIR"
pnpm build
pnpm pack

# 2. resolve version + tgz name (@openclaw/dynamic-workflows → openclaw-dynamic-workflows-<ver>.tgz)
VERSION="$(node -p "require('./package.json').version")"
TGZ="openclaw-dynamic-workflows-${VERSION}.tgz"
[ -f "$TGZ" ] || { echo "pack did not produce $TGZ" >&2; exit 1; }

# 3. stage tgz into MA resources/dynamic-workflows/; drop stale-version tgz
mkdir -p "$MA_RES_DIR"
cp "$PKG_DIR/$TGZ" "$MA_RES_DIR/$TGZ"
find "$MA_RES_DIR" -name 'openclaw-dynamic-workflows-*.tgz' ! -name "$TGZ" -print -delete || true

# 4. update MA package.json file: ref (sed preserves formatting)
WANT="file:resources/dynamic-workflows/${TGZ}"
sed -i.bak -E "s|file:resources/dynamic-workflows/openclaw-dynamic-workflows-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${WANT}|" "$MA_ROOT/package.json" && rm -f "$MA_ROOT/package.json.bak"
echo "MA dependency → ${WANT}"

# 5. MA install + rebuild the claw-plugin copy the Gateway loads
cd "$MA_ROOT"
pnpm install
pnpm build:dynamic-workflows-plugin

echo "✓ @openclaw/dynamic-workflows ${VERSION} synced to MA"
echo "next: commit MA — package.json + resources/dynamic-workflows/${TGZ} + resources/claw-plugin/dynamic-workflows/"
