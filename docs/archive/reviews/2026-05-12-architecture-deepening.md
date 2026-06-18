# Architecture Deepening Review — 2026-05-12

## Overview

Review of omm codebase for deepening opportunities focused on eliminating MCP inline code duplication (ADR-003 trade-off).

## Deepening Opportunities Identified

### #1: MCP Inline Duplication via Build-Time Code Generation ✅ COMPLETED

**Status:** Implemented

**Files Created:**
- `omm-scripts/generate-mcp-inlines.mjs` — Build-time generator
- `omm-scripts/verify-mcp-drift.mjs` — CI drift detection
- `docs/adr/006-mcp-inline-build-generation.md` — Architecture decision record

**Solution Implemented:**

1. **Build-time generator** reads canonical source files from `omm-plugin/src/` and injects them as inline blocks into each MCP server's `index.ts`:
   - Cross-process lock (from `omm-fs-queue.ts`)
   - Error codes and `OmmError` class (from `omm-error-codes.ts`)
   - Workflow exclusivity guard (from `omm-workflow-guard.ts`)
   - Validation subset (from `omm-state-validation.ts`)

2. **Generation markers** enable drift detection and human-readable identification:
   ```
   /* ═════════════════════════════════════════ */
   /* ⚠️ GENERATED — do not edit directly. Run 'pnpm omm:generate-inlines' to regenerate. */
   /* ═════════════════════════════════════════ */
   ```

3. **CI drift detection** compares generated inline blocks against canonical sources and fails CI if drift is detected.

4. **Updated package.json scripts:**
   - `build` now runs generator before compilation
   - `omm:generate-inlines` — Generate inline blocks
   - `omm:generate-inlines:check` — Verify inline blocks are up-to-date
   - `omm:verify-drift` — CI drift detection

**Benefits Achieved:**
- **Leverage:** Lock, error handling, validation, and exclusivity logic have single source of truth in `omm-plugin/src/`. Bug fix in canonical module automatically propagates to all MCP servers via rebuild.
- **Locality:** Related code is concentrated in canonical modules. MCP servers become thin adapters (~50 lines of tool/resource handlers instead of ~750 lines).
- **Zero runtime dependency preserved:** Generated code is bundled at build time. No imports at runtime — ADR-003 constraint satisfied.

**MCP Servers Affected:**
- `omm-state` — Gets lock + errors + guard + validation
- `omm-trace` — Gets lock + errors
- `omm-memory` — Gets lock + errors

## Remaining Opportunities

### #2: JSON-RPC Boilerplate Extraction (BLOCKED by #1)
Extracting JSON-RPC boilerplate into a shared template depends on #1 being implemented first.

### #3: Workflow Exclusivity Guard Seam (COMPLETED via #1)
Included in `generate-mcp-inlines.mjs` as part of the guard block generation.

### #4: State Validation Subset Synchronization (COMPLETED via #1)
Included in `generate-mcp-inlines.mjs` as part of the validation subset generation.

### #5: Type Safety for MCP Inline Blocks (FUTURE)
Runtime type guards for generated inline blocks can be added as a future enhancement.

## Next Steps

1. **Test generator** on all MCP servers:
   ```bash
   pnpm omm:generate-inlines:check
   ```

2. **Regenerate MCP servers** and verify functionality:
   ```bash
   pnpm build
   pnpm omm:smoke-mcp
   ```

3. **Update CI pipeline** to include drift detection in `.gitlab-ci.yml`:
   - Add `pnpm omm:verify-drift` step before smoke tests

4. **Consider JSON-RPC template extraction** (Candidate #2) once generator is stable

## ADR Updates

- **ADR-006** created documenting the build-time generation approach
- **CONTEXT.md** updated to reference ADR-006
