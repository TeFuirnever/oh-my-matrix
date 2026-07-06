# ADR-018: Windows is a CI-verified support tier

## Status

Accepted (2026-07-06).

## Context

Historically this monorepo's only platform signal was the `Operating System` dropdown in `.github/ISSUE_TEMPLATE/bug_report.yml` (Windows / macOS / Linux), which let users *file* bugs as occurring on Windows. Nothing else backed the claim:

- **CI ran `ubuntu-latest` only.** All six jobs in `.github/workflows/ci.yml` (lint, typecheck, commitlint, test, hook-priority, audit) plus `release.yml` and `docs.yml` were single-OS. No `strategy.matrix` existed anywhere.
- **Production source has Windows-specific code paths** that were never exercised in automation: `command-runner.ts` `.cmd`/`.bat` fallback + CVE-2024-27980 `shell:true` mitigation (lines 73-126), `permission-policy.ts` Windows dangerous-command classification (`runas`, `icacls`, `sc`, `format`, `reg` — lines 213-221), and `command-runner.test.ts`'s `it.runIf(process.platform === 'win32')` branches.
- **README and CONTEXT.md were silent** on platform support — no "Supported platforms" section, no WSL requirement note.
- `.gitattributes` forced LF (a Windows-friendly checkout accommodation) and `CONTRIBUTING.md` documents `publish.sh` needs Git Bash / WSL, but neither established a *support tier*.

This is the "Invisible Decision" anti-pattern called out in `AGENTS.md`: a CI change that silently upgraded Windows from "best-effort" to "verified" without a design record. Once `windows-latest` is in the matrix, removing it later reads as a regression — so the commitment must be explicit and reversible only through deliberate decision, not drift.

## Decision

**Windows is a CI-verified, Tier-1 support platform alongside macOS/Linux (ubuntu).** The support tier contract:

1. **CI matrix.** The `lint`, `typecheck`, and `test` jobs in `ci.yml` run on `strategy.matrix.os: [ubuntu-latest, windows-latest]`. The `commitlint`, `hook-priority`, and `audit` jobs remain ubuntu-only because they operate on git metadata, source constants, or registry data with no OS dependence — this split is principled and documented here, not accidental.
2. **`shell: bash` on every GitHub Actions step** that uses POSIX shell syntax (`printf >> "$GITHUB_STEP_SUMMARY"`, `[ ... ]` tests). windows-latest defaults to PowerShell, which does not expand `$VAR` or handle `>>` the same way; bash is available via Git for Windows.
3. **Windows-specific code paths are load-bearing** (`.cmd` resolution, CVE-2024-27980 mitigation, Windows command classification) and MUST be exercised by the windows-latest lane. The `it.runIf(win32)` / `it.skipIf(win32)` branches in `command-runner.test.ts` are the contract surface.
4. **Removing `windows-latest` from CI is a breaking change to this ADR** and requires a superseding ADR. It is not a casual cleanup.
5. **macOS (`macos-latest`) is NOT in the CI matrix.** It is consumed implicitly: macOS is POSIX-compliant with Linux, the maintainer develops on macOS, and the cost/benefit of a third OS lane does not justify it today. macOS remains "best-effort" — bugs filed against macOS are valid but not CI-gated.

## Why three jobs on Windows, not all six

| Job | On Windows? | Reason |
|---|---|---|
| `lint` (eslint + markdownlint) | Yes | Toolchain execution differs by OS; catches path/encoding assumptions in lint config. |
| `typecheck` | Yes | `tsc` is OS-agnostic but the *build* (`pnpm -r build`) and module resolution are not — exercises the real consumer path. |
| `test` | Yes | The highest-value lane. Vitest's symlink, temp-dir, and `process.platform` branches only execute here. |
| `commitlint` | No | Pure git-metadata check (`commitlint --from SHA --to SHA`). Zero OS dependence. |
| `hook-priority` | No | Now a portable Node script (`scripts/check-hook-priority.cjs`) reading two source files. OS-agnostic by construction. |
| `audit` | No | `pnpm audit --prod` queries the npm registry. OS-agnostic. |

The split follows one rule: **a job runs on Windows if and only if it executes OS-coupled tooling (build, test, lint runtime).** Metadata/registry jobs stay ubuntu-only to halve CI cost without losing coverage.

## Consequences

**Positive:**
- Windows-specific regressions (path separators, `.cmd` resolution, CRLF parsing, symlink privilege) are caught before merge instead of after a user files a bug.
- The CVE-2024-27980 mitigation in `command-runner.ts` is finally exercised in automation — previously it was tested only via `it.runIf` branches that never ran on ubuntu-only CI.
- The `bug_report.yml` OS dropdown is now backed by evidence rather than aspiration.
- Future contributors adding a job have an explicit rule (this ADR's table) for deciding whether it needs the Windows lane.

**Negative:**
- CI wall-clock time and runner-minutes increase (roughly +1 lane per matrixed job). Mitigated by `fail-fast: false` so one OS failure doesn't cancel the other, and by keeping metadata jobs single-OS.
- Windows pnpm install has historically had flake around the symlink-based store. If this becomes chronic, the mitigation is `PNPM_HOME` config or `node-linker=hoisted`, not removing the lane.
- macOS is not CI-gated. A macOS-only regression (e.g. case-sensitive HFS+ edge case) can still ship. Accepted: the maintainer develops on macOS, so local runs catch most of these.

## Alternatives Considered

- **Keep ubuntu-only CI, document Windows as "best-effort".** Rejected: the production code already contains non-trivial Windows logic (CVE mitigation, command classifier). Best-effort status for code we actively maintain is dishonest — either verify it or delete the Windows paths.
- **Add `macos-latest` too (full 3-OS matrix).** Rejected for cost/benefit: macOS adds a third lane for marginal coverage beyond what ubuntu (POSIX) + windows (the divergent platform) already provide. Can be revisited if a macOS-specific bug class emerges.
- **Use WSL on Windows runners instead of native windows-latest.** Rejected: WSL hides exactly the native-Windows bugs (`.cmd` resolution, PowerShell shell defaults, drive-letter paths) that this tier exists to catch.

## Related

- `.github/workflows/ci.yml` — the matrix change this ADR records.
- `.github/ISSUE_TEMPLATE/bug_report.yml:56-60` — the pre-existing OS dropdown; now evidence-backed.
- `packages/autopilot/src/command-runner.ts:73-126` — CVE-2024-27980 mitigation, now CI-exercised.
- `packages/autopilot/tests/command-runner.test.ts` — `it.runIf(win32)` / `it.skipIf(win32)` branches.
- `CONTRIBUTING.md` §Releasing — Windows maintainers need Git Bash / WSL for `publish.sh`.
- [ADR-013](013-permission-policy-library.md) — peerDep-only coupling model; the published packages carry zero runtime dependencies, which is why `cross-spawn` is NOT used and the CVE-2024-27980 mitigation is hand-rolled in `command-runner.ts`.
