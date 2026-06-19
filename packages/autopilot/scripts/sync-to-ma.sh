#!/usr/bin/env bash
# sync-to-ma.sh — refresh MA's @openclaw/autopilot from this source.
#
# Runs the full distribution chain: omm build+pack → copy tgz into MA →
# update MA's package.json version ref → MA install → MA build:autopilot-plugin.
# Eliminates the 4-step manual drift (ADR-010 follow-up #1).
#
# Usage: ./sync-to-ma.sh [MA_ROOT]   (default MA_ROOT = ../../MatrixAssistant)
#
# ponytail: assumes omm and MA are sibling dirs; pass MA_ROOT to override.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"            # packages/autopilot
OMM_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
MA_ROOT="${1:-$OMM_ROOT/../MatrixAssistant}"
MA_RES_DIR="$MA_ROOT/resources/autopilot"

[ -f "$MA_ROOT/package.json" ] || { echo "MA_ROOT not found: $MA_ROOT" >&2; exit 1; }

# 1. build + pack in omm
cd "$PKG_DIR"
pnpm build
pnpm pack

# 2. resolve version + tgz name
VERSION="$(node -p "require('./package.json').version")"
TGZ="openclaw-autopilot-${VERSION}.tgz"
[ -f "$TGZ" ] || { echo "pack did not produce $TGZ" >&2; exit 1; }

# 3. stage tgz into MA resources/autopilot/; drop stale-version tgz
mkdir -p "$MA_RES_DIR"
cp "$PKG_DIR/$TGZ" "$MA_RES_DIR/$TGZ"
find "$MA_RES_DIR" -name 'openclaw-autopilot-*.tgz' ! -name "$TGZ" -print -delete || true

# 4. update MA package.json file: ref (sed, not JSON rewrite — preserves formatting)
WANT="file:resources/autopilot/${TGZ}"
sed -i.bak -E "s|file:resources/autopilot/openclaw-autopilot-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${WANT}|" "$MA_ROOT/package.json" && rm -f "$MA_ROOT/package.json.bak"
echo "MA dependency → ${WANT}"

# 5. MA install + rebuild the claw-plugin copy the Gateway loads
cd "$MA_ROOT"
pnpm install
pnpm build:autopilot-plugin

echo "✓ @openclaw/autopilot ${VERSION} synced to MA"
echo "next: commit MA — package.json + resources/autopilot/${TGZ}"
