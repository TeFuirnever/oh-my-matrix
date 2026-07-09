#!/usr/bin/env bash
# Publish the three @oh-my-matrix packages to npm, in dependency order,
# with pre-flight validation and post-publish verification.
#
# Usage:
#   ./scripts/publish.sh                          # real publish (all three)
#   ./scripts/publish.sh --dry-run                # validate without publishing
#   ./scripts/publish.sh --only <pkg>             # publish a single package
#   ./scripts/publish.sh --only <pkg> --dry-run   # validate a single package
#
# Publish order is fixed by the peer-dependency graph (leaf first):
#   permission-policy  (leaf, no peerDeps)
#   dynamic-workflows  (peerDeps: permission-policy)
#   autopilot          (peerDeps: permission-policy)
#
# --only: publish a subset (e.g. to ship a security fix without riding along
# unrelated work). The selected package(s) still must each be version-ahead of
# the registry. Order is preserved; dependents are NOT auto-included (if you
# --only permission-policy, dynamic-workflows/autopilot are not republished).
#
# See CONTRIBUTING.md § Releasing for version-bump guidance.
set -euo pipefail

ALL_PACKAGES=("permission-policy" "dynamic-workflows" "autopilot")
DRY_RUN=""
ONLY=""

# ── 0. Parse args ────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    --only)
      ONLY="$2"; shift 2
      if ! printf '%s\n' "${ALL_PACKAGES[@]}" | grep -qx "$ONLY"; then
        echo "FAIL: --only '$ONLY' is not one of: ${ALL_PACKAGES[*]}"; exit 1
      fi
      ;;
    *) echo "FAIL: unknown arg '$1'"; exit 1 ;;
  esac
done

if [ -n "$ONLY" ]; then
  PACKAGES=("$ONLY")
else
  PACKAGES=("${ALL_PACKAGES[@]}")
fi

# ── 1. Pre-flight validation ────────────────────────────────────────────────

echo "=== 1. Pre-flight validation (${PACKAGES[*]}) ==="

# 1a. Working tree must be clean (avoid publishing uncommitted state)
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: working tree dirty — commit or stash before publishing"
  git status --short
  exit 1
fi

# 1b. Version alignment: package.json must match openclaw.plugin.json (if present)
#     AND index.ts `export const version` (if present). S14 drift guard.
for pkg in "${PACKAGES[@]}"; do
  pj_v=$(node -p "require('./packages/' + '${pkg}' + '/package.json').version")
  if [ -f "packages/${pkg}/openclaw.plugin.json" ]; then
    pl_v=$(node -p "require('./packages/' + '${pkg}' + '/openclaw.plugin.json').version")
    if [ "$pj_v" != "$pl_v" ]; then
      echo "FAIL: ${pkg} version drift (package.json=${pj_v} plugin.json=${pl_v})"
      exit 1
    fi
  fi
  if [ -f "packages/${pkg}/index.ts" ]; then
    # Extract the `export const version = '<v>';` value from index.ts source.
    # `|| true` guards: a pure-library package (e.g. permission-policy) may
    # have an index.ts but no `export const version` — grep returns 1 on no
    # match, which under `set -euo pipefail` would silently kill the script.
    idx_v=$(grep -E "export[[:space:]]+const[[:space:]]+version[[:space:]]*=" "packages/${pkg}/index.ts" | head -1 | sed -E "s/.*version[[:space:]]*=[[:space:]]*'([^']*)'.*/\1/" || true)
    if [ -n "$idx_v" ] && [ "$pj_v" != "$idx_v" ]; then
      echo "FAIL: ${pkg} version drift (package.json=${pj_v} index.ts=${idx_v})"
      echo "  fix: run 'node scripts/sync-plugin-versions.cjs' to sync, or hand-edit packages/${pkg}/index.ts"
      exit 1
    fi
  fi
  echo "  ${pkg} ${pj_v} OK"
done

# 1c. npm authentication (skip for --dry-run, which doesn't hit the registry)
if [ "$DRY_RUN" != "--dry-run" ]; then
  if ! npm whoami > /dev/null 2>&1; then
    echo "FAIL: not logged in to npm (run: npm login)"
    exit 1
  fi
  echo "  npm user: $(npm whoami)"
fi

# 1d. Versions must be higher than what's on the registry (catch re-publish)
for pkg in "${PACKAGES[@]}"; do
  local_v=$(node -p "require('./packages/' + '${pkg}' + '/package.json').version")
  registry_v=$(npm view "@oh-my-matrix/${pkg}" version 2>/dev/null || echo "none")
  if [ "$local_v" = "$registry_v" ]; then
    echo "FAIL: @oh-my-matrix/${pkg}@${local_v} already published — bump the version first"
    exit 1
  fi
  echo "  @oh-my-matrix/${pkg}: ${registry_v} (registry) -> ${local_v} (local)"
done

# ── 2. Build (regenerate dist from source per ADR-015) ─────────────────────

echo "=== 2. Build (regenerate dist) ==="
pnpm -r build

# ── 3. Publish in dependency order ──────────────────────────────────────────

echo "=== 3. Publish (order: leaf -> dependents) ==="
for pkg in "${PACKAGES[@]}"; do
  echo "--- ${pkg} ---"
  if [ "$DRY_RUN" = "--dry-run" ]; then
    (cd "packages/${pkg}" && npm publish --access public --dry-run)
  else
    (cd "packages/${pkg}" && npm publish --access public)
  fi
done

# ── 4. Post-publish: verify + tag (real publish only) ──────────────────────

if [ "$DRY_RUN" != "--dry-run" ]; then
  echo "=== 4. Verify published artifacts ==="
  if [ -n "$ONLY" ]; then
    bash "$(dirname "$0")/verify-publish.sh" --only "$ONLY"
  else
    bash "$(dirname "$0")/verify-publish.sh"
  fi

  echo "=== 5. Tag the release commit ==="
  for pkg in "${PACKAGES[@]}"; do
    v=$(node -p "require('./packages/' + '${pkg}' + '/package.json').version")
    tag="${pkg}-v${v}"
    if git rev-parse "$tag" > /dev/null 2>&1; then
      echo "  ${tag} (exists)"
    else
      git tag -a "$tag" -m "${pkg} ${v}"
      echo "  ${tag} (created)"
    fi
  done
  git push origin --tags
fi

echo "=== Done ==="
