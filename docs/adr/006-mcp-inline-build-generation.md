# ADR-006: MCP Inline Code via Build-Time Generation

## Status

Accepted, 2026-05-12.

## Context

ADR-003 commits to zero runtime dependencies for MCP servers. As a result, each MCP server (`omm-state`, `omm-trace`, `omm-memory`) inlines approximately 200 lines of duplicated code:

- `OmmError` class and error code constants (3 copies)
- `withCrossProcessLock` cross-process lock implementation (3 copies, identical to `omm-fs-queue.ts`)
- `withKeyLock` serialization queue (3 copies)
- JSON-RPC request/response builders (3 copies)
- Stdin reader loop with parse error handling (3 copies)
- Workflow exclusivity guard (2 copies, duplicating `omm-workflow-guard.ts`)
- State validation subset (2 copies, duplicating `omm-state-validation.ts`)

Bug fixes must be manually applied to all 4+ locations (plugin + 3 MCP servers). The existing CI smoke test (`pnpm omm:smoke-mcp`) only detects runtime failures, not drift in inline code.

The duplication creates several issues:
1. **Maintenance burden:** Single bug requires 4+ edits
2. **Drift risk:** Manual updates may not be applied consistently across all servers
3. **Locality loss:** The same logic lives in multiple places, violating single source of truth
4. **Test coverage gap:** Plugin tests for canonical modules don't automatically validate MCP implementations

## Decision

omm introduces build-time code generation to eliminate manual duplication while preserving ADR-003's zero-dependency requirement.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Build Time                         │
│                                                       │
│  Canonical Source Files                 Generated MCP Servers   │
│  (omm-plugin/src/)               (omm-mcp/src/)       │
│  ────────────────────────┐        ┌───────────────────┐       │
│  │ omm-fs-queue.ts       │        │ omm-state/index.ts│       │
│  │ omm-error-codes.ts     │        │ omm-trace/index.ts│       │
│  │ omm-workflow-guard.ts   │        │ omm-memory/index.ts│       │
│  ────────────────────────┘        └───────────────────┘       │
│                                                       │
│           omm-scripts/generate-mcp-inlines.mjs        │
│                  (generator)                        │
└─────────────────────────────────────────────────────┘

                        Runtime
          omm-mcp/dist/index.js (bundled with inlines)
```

### Build Process

1. **Generator** (`omm-scripts/generate-mcp-inlines.mjs`):
   - Reads canonical source files from `omm-plugin/src/`
   - Extracts inline blocks using AST-based parsing
   - Injects blocks into each MCP server's `index.ts`
   - Marks generated code with `/* ═══════════════ */` delimiters

2. **Build** (updated `pnpm build`):
   - Runs generator before compilation
   - Compiles generated code to JS in `omm-mcp/dist/`

3. **Verification** (`omm-scripts/verify-mcp-drift.mjs`):
   - Extracts canonical blocks from source files
   - Extracts generated blocks from MCP servers
   - Compares for drift
   - Fails CI if differences detected

### Generated Blocks

Each MCP server receives the following inline blocks:

| Block | Source | Servers | Purpose |
|--------|--------|---------|---------|
| Cross-process lock | `omm-fs-queue.ts` | `omm-state`, `omm-trace`, `omm-memory` |
| Error codes | `omm-error-codes.ts` | `omm-state`, `omm-trace`, `omm-memory` |
| Workflow guard | `omm-workflow-guard.ts` | `omm-state`, `omm-trace` |
| Validation subset | `omm-state-validation.ts` | `omm-state` |

**Note:** `omm-trace` and `omm-memory` exclude workflow guard and validation (they use different invariants).

### Generation Markers

Generated code is delimited by:
```
/* ═══════════════════════════════════════════ */
/* ⚠️ GENERATED — do not edit directly. Run 'pnpm omm:generate-inlines' to regenerate. */
/* ═══════════════════════════════════════════════════ */
```

These markers enable:
- Drift detection (CI compares between markers)
- Human reviewers can identify generated code at a glance
- Prevents accidental edits to generated blocks

## Consequences

**Positive:**

- **Single source of truth:** Lock, error handling, validation, and exclusivity logic live only in `omm-plugin/src/` modules.
- **Leverage:** Bug fix in canonical module automatically propagates to all MCP servers via rebuild.
- **Locality:** Related code is concentrated in their canonical modules. MCP servers become thin adapters.
- **Test coverage:** Plugin tests for canonical modules now indirectly validate MCP implementations.
- **Zero runtime dependency preserved:** Generated code is bundled at build time. No imports at runtime.
- **CI enforcement:** `omm:verify-drift` catches drift before release, preventing accidental divergence.

**Negative:**

- **Build-time dependency:** Requires Node.js to generate code (trivial, already in CI pipeline).
- **Generated code is not directly testable:** Unit tests target canonical modules. Generated MCP code inherits coverage indirectly.
- **Tooling gap:** No dedicated AST-based extraction library for inline blocks; manual maintenance of extraction logic.
- **Debugging complexity:** Breakpoints in MCP servers may be less useful (debugger steps into generated code). Can be mitigated by keeping generated blocks compact.

**Trade-off accepted:** Build-time generation adds a small tooling complexity but eliminates a critical maintenance burden and drift risk. The zero-dependency constraint is preserved since code is bundled, not imported.

## Migration Path

1. Add generator script to `omm-scripts/`
2. Update `package.json` to run generator before build
3. Add drift verification script to CI
4. Regenerate MCP servers: `pnpm omm:generate-inlines`
5. Verify: `pnpm omm:generate-inlines:check`
6. Update ADR-003 documentation to reference this ADR

## Related ADRs

- **ADR-003:** Zero-dependency MCP implementation (still enforced via build-time generation)
- **ADR-005:** Cross-process locking design (canonical implementation in `omm-fs-queue.ts`)

## Alternatives Considered

**Maintain manual duplication:** Rejected. Violates DRY principle, creates maintenance burden, drift risk. Current state is unsustainable for 3+ MCP servers.

**Pull in shared package as npm dependency:** Rejected. Violates ADR-003 zero-dependency requirement. Would require runtime dependency on all MCP servers.

**AST-based extraction library:** Considered but rejected due to maintenance overhead. Manual block extraction with delimiters is sufficient for current scale (3 servers, ~200 lines each).

**Shared `.gitignore` rule for generated files:** Rejected. Generated files need to be committed for CI. Developer should regenerate locally and check in changes.

## Implementation Notes

### AST-Based Extraction Challenges

Block extraction uses line-based parsing with indentation tracking rather than full AST. This approach:

- Works well for function and const declarations
- Handles TypeScript-specific syntax (types, interfaces, exports)
- Requires careful handling of template literals and multi-line strings
- May need updates if canonical code uses complex patterns

The extraction logic is intentionally conservative: it extracts complete blocks rather than minimal subsets to ensure drift detection catches all changes.

### Generator Safety Features

1. **Dry-run mode:** `--check` flag verifies without writing
2. **Explicit marker detection:** Finds existing generated blocks before overwriting
3. **Graceful insertion:** Preserves file structure (imports, shebang, comments)
4. **Per-server customization:** Different MCP servers can require different inline blocks

## Rollback

If drift is detected or generation fails:
1. Restore MCP server source from git
2. Investigate generator logic
3. Fix and regenerate

Never manually edit inline blocks in MCP servers. Always regenerate via generator.
