#!/usr/bin/env bash
# Build @openclaw/{permission-policy,dynamic-workflows,autopilot} and sync their
# dist/ into MatrixAssistant so MA loads the freshly built guard on next restart.
#
# Why both node_modules AND resources/claw-plugin:
#   - MA's build:dynamic-workflows-plugin / build:autopilot-plugin (run during
#     `pnpm dev`) copy from node_modules/@openclaw/<pkg> → resources/claw-plugin/<pkg>.
#     So node_modules is the source of truth MA's build reads.
#   - We also write resources/claw-plugin directly so the fix is live even before
#     MA's next build:prelaunch re-copies (and survives if MA is already running
#     with a cached module — the on-disk file is correct for the restart).
#   - permission-policy is a library (not a claw-plugin), so it only lives in
#     node_modules — but BOTH plugins require it at runtime, so forgetting it
#     makes the guard throw "extractCommandSegments is not a function" (the
#     2026-06-28 deploy hole).
#
# Usage:  bash scripts/sync-to-ma.sh        # from repo root
#         MA_DIR=/path/to/MA bash scripts/sync-to-ma.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MA_DIR="${MA_DIR:-$ROOT/../MatrixAssistant}"
cd "$ROOT"

PACKAGES=(permission-policy dynamic-workflows autopilot)
PLUGINS=(dynamic-workflows autopilot)   # only these live under resources/claw-plugin

echo "==> building (tsc)..."
for pkg in "${PACKAGES[@]}"; do
  pnpm -C "packages/$pkg" build
done

echo "==> syncing dist → $MA_DIR"
for pkg in "${PACKAGES[@]}"; do
  src="packages/$pkg/dist"
  [ -d "$src" ] || { echo "ERROR: $src missing (build failed?)"; exit 1; }
  dest="$MA_DIR/node_modules/@openclaw/$pkg/dist"
  if [ -d "$dest" ]; then
    cp -r "$src/." "$dest/"
    echo "  $pkg → node_modules/@openclaw/$pkg/dist"
  else
    echo "  SKIP $pkg: $dest not present (MA not installed?)"
  fi
done
for pkg in "${PLUGINS[@]}"; do
  src="packages/$pkg/dist"
  dest="$MA_DIR/resources/claw-plugin/$pkg/dist"
  if [ -d "$dest" ]; then
    cp -r "$src/." "$dest/"
    echo "  $pkg → resources/claw-plugin/$pkg/dist"
  fi
done

echo "==> done. Restart MA (cd $MA_DIR && pnpm dev) to load."
