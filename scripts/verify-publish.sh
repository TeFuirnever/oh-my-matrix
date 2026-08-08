#!/usr/bin/env bash
# Verify that the three @oh-my-matrix packages published to npm contain the
# expected content. Downloads each tarball from the registry and checks key
# files/symbols. Run after `publish.sh` (or manually to spot-check).
#
# Usage:
#   ./scripts/verify-publish.sh                    # verify all three
#   ./scripts/verify-publish.sh --only <pkg>       # verify a single package
#
# Exit: 0 if all checks pass, 1 if any package fails verification.
set -euo pipefail

ONLY=""
if [ "${1:-}" = "--only" ]; then
  ONLY="$2"
  case "$ONLY" in
    permission-policy|dynamic-workflows|autopilot) ;;
    *) echo "FAIL: --only '$ONLY' is not a known package"; exit 1 ;;
  esac
fi

# A package runs when no --only was passed, or when --only selected it.
run_pkg() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "  PASS: ${desc}"
  else
    echo "  FAIL: ${desc}"
    FAIL=1
  fi
}

echo "=== Verifying published packages${ONLY:+ ($ONLY)} ==="

# ── permission-policy: critical API exports ─────────────────────────────────

if run_pkg permission-policy; then
echo "--- @oh-my-matrix/permission-policy ---"
pp_v=$(node -p "require('./packages/permission-policy/package.json').version")
(cd "$TMPDIR" && npm pack "@oh-my-matrix/permission-policy@${pp_v}" > /dev/null 2>&1)
mkdir -p "$TMPDIR/pp"
tar -xzf "$TMPDIR"/oh-my-matrix-permission-policy-*.tgz -C "$TMPDIR/pp"

grep -q "decidePermissionForEvent" "$TMPDIR/pp/package/dist/index.js" && check "decidePermissionForEvent export" 0 || check "decidePermissionForEvent export" 1
grep -q "tokenizeShell" "$TMPDIR/pp/package/dist/index.js" && check "tokenizeShell export" 0 || check "tokenizeShell export" 1
grep -q "extractCommandSegments" "$TMPDIR/pp/package/dist/index.js" && check "extractCommandSegments export" 0 || check "extractCommandSegments export" 1
fi

# ── dynamic-workflows: skill layer + guard ──────────────────────────────────

if run_pkg dynamic-workflows; then
echo "--- @oh-my-matrix/dynamic-workflows ---"
dw_v=$(node -p "require('./packages/dynamic-workflows/package.json').version")
(cd "$TMPDIR" && npm pack "@oh-my-matrix/dynamic-workflows@${dw_v}" > /dev/null 2>&1)
mkdir -p "$TMPDIR/dw"
tar -xzf "$TMPDIR"/oh-my-matrix-dynamic-workflows-*.tgz -C "$TMPDIR/dw"

# SKILL.md present with leading word
[ -f "$TMPDIR/dw/package/skill/SKILL.md" ] && check "SKILL.md present" 0 || check "SKILL.md present" 1
grep -q "refute" "$TMPDIR/dw/package/skill/SKILL.md" && check "SKILL.md _refute_ leading word" 0 || check "SKILL.md _refute_ leading word" 1

# 14 role-prompts
role_count=$(ls "$TMPDIR/dw/package/skill/references/role-prompts/"*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$role_count" = "14" ] && check "14 role-prompts (got ${role_count})" 0 || check "14 role-prompts (got ${role_count})" 1

# 7 reference files
ref_count=$(ls "$TMPDIR/dw/package/skill/references/"*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$ref_count" = "7" ] && check "7 reference files (got ${ref_count})" 0 || check "7 reference files (got ${ref_count})" 1

# plugin.json version aligned
pl_v=$(node -p "require('$TMPDIR/dw/package/openclaw.plugin.json').version")
[ "$pl_v" = "$dw_v" ] && check "plugin.json version == package.json (${pl_v})" 0 || check "plugin.json version drift (plugin=${pl_v} package=${dw_v})" 1

# guard registers before_tool_call
grep -q "before_tool_call" "$TMPDIR/dw/package/dist/index.js" && check "guard registers before_tool_call" 0 || check "guard registers before_tool_call" 1
fi

# ── autopilot 4.0.0: E13 resume_run RPC + E2/E12/E5 markers ────────────────

if run_pkg autopilot; then
echo "--- @oh-my-matrix/autopilot ---"
ap_v=$(node -p "require('./packages/autopilot/package.json').version")
(cd "$TMPDIR" && npm pack "@oh-my-matrix/autopilot@${ap_v}" > /dev/null 2>&1)
mkdir -p "$TMPDIR/ap"
tar -xzf "$TMPDIR"/oh-my-matrix-autopilot-*.tgz -C "$TMPDIR/ap"

# E13 (4.0.0 breaking): explicit resume_run RPC
grep -q "resume_run" "$TMPDIR/ap/package/dist/index.js" && check "E13: resume_run RPC present" 0 || check "E13: resume_run RPC MISSING" 1

# E12: cross_turn_enqueued reducer event
grep -q "cross_turn_enqueued" "$TMPDIR/ap/package/dist/index.js" && check "E12: cross_turn_enqueued present" 0 || check "E12: cross_turn_enqueued MISSING" 1

# E5: progress ledger
grep -q "ledger" "$TMPDIR/ap/package/dist/index.js" && check "E5: progress ledger present" 0 || check "E5: progress ledger MISSING" 1

# E2: wallclock hard cap
grep -q "maxDurationMs" "$TMPDIR/ap/package/dist/index.js" && check "E2: maxDurationMs cap present" 0 || check "E2: maxDurationMs cap MISSING" 1

# Version in dist matches package
grep -q "$ap_v" "$TMPDIR/ap/package/dist/index.js" && check "version ${ap_v} in dist" 0 || check "version ${ap_v} not found in dist" 1
fi

# ── Result ──────────────────────────────────────────────────────────────────

echo ""
if [ "$FAIL" = "0" ]; then
  echo "=== ALL CHECKS PASSED ==="
else
  echo "=== SOME CHECKS FAILED — investigate before announcing release ==="
  exit 1
fi
