---
"@oh-my-matrix/autopilot": major
"@oh-my-matrix/dynamic-workflows": major
---

Move the OpenClaw baseline to 2026.7.1-2 (**BREAKING** — drops 2026.5.28–2026.7.1-1):

- peer `openclaw`: `>=2026.5.28 <2027` → `>=2026.7.1-2 <2027`. Single supported
  baseline; no back-compat range. Consumers on an older OpenClaw host stay on the
  previous plugin release (`@oh-my-matrix/autopilot@3.1.0` /
  `@oh-my-matrix/dynamic-workflows@0.2.0` on npm, plus the matching git tag) — that
  is what the historical packages and tags are for.
- Note on the range form: `>=2026.7.1-2` (not `>=2026.7.1`) is required because
  semver treats the `-N` correction as a prerelease and excludes it from a plain
  range — `satisfies("2026.7.1-2", ">=2026.7.1")` is false under pnpm@10.24.0 +
  semver@7.8.5. The `-2` floor still admits the stable base `2026.7.1` and later
  (`2026.7.2`, …).
- Also dropped: `extended-stable` 2026.6.33 is no longer in range. Deliberate —
  OMM tracks OpenClaw `latest`.
- devDep/test baseline pinned `openclaw@2026.7.1-2`.
- SDK drift: `PluginHookBeforeToolCallEvent` gained optional `toolKind` /
  `toolInputKind` / `derivedPaths` in openclaw 2026.7.1
  (`src/plugins/hook-types.ts`); refreshed stale "NO toolKind" claims across
  `event-shape.contract.ts` (both packages), both `before_tool_call` `index.ts`
  notes, the `subagent-guard.test.ts` header, and
  `docs/fixes/runtime-guard-event-shape.md`. No behavioral change — the new fields
  are unused (verified: `decidePermissionForEvent` does not forward `toolKind` into
  `classifyCommand`).

Maintenance note: future OpenClaw corrections of a different base (e.g.
`2026.7.2-1`, `2026.8.0-1`) will NOT match this peer form — the floor must be
re-pinned each time OMM adopts a new correction. Inherent to OpenClaw's
CalVer+correction scheme under semver (no `-0` trick or range variant avoids it).
With a single-baseline policy this rebase is now the routine upgrade step.
