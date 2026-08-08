# @oh-my-matrix/dynamic-workflows

## 1.0.0

### Major Changes

- [`0f32fab`](https://github.com/TeFuirnever/oh-my-matrix/commit/0f32fabd55fb0a4a75f92432c501965d55e7d969) - Move the OpenClaw baseline to 2026.7.1-2 (**BREAKING** — drops 2026.5.28–2026.7.1-1):

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

## 0.2.0

### Minor Changes

- [`fb0857f`](https://github.com/TeFuirnever/oh-my-matrix/commit/fb0857f3163f30597d613f4a759f448941ac95c7) - Open refute-gate-compatible productive patterns in the skill: implement-then-review (duel-loop), generate-then-filter (test-gen), select-via-judge (tournament) templates, Refute-gate compatibility section, disclosed Resource limits + Safety references, writing-great-skills optimization (description sharpening, single-source-of-truth, progressive disclosure). Explicitly excludes pure parallel-implement and pure batch-migrate (no natural refute gate).

## 0.1.4

### Patch Changes

- [#109](https://github.com/TeFuirnever/oh-my-matrix/pull/109) [`da6fbcc`](https://github.com/TeFuirnever/oh-my-matrix/commit/da6fbcc69cbc42245f312c00a2b61c2241fdbabc) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Fix guard logger throwing into the fail-closed before_tool_call handler (DEC-2).

  `emitJson()` called `JSON.stringify` without a try/catch. When ctx contained a
  circular reference or BigInt, the throw propagated up to the guard handler's
  fail-closed catch and was converted into a mis-block of a legitimate subagent
  tool call (with the real reason masked). The double-write ordering also meant
  the skipped logger call could skip the subsequent `appendAuditEntry`, losing
  the audit record.

  Mirrors the accepted fix already shipped in `@oh-my-matrix/autopilot`:

  - `emitJson`: wrap `JSON.stringify` in try/catch with an unserializable
    fallback record (`{ts, level, msg, ctxError:'unserializable'}`) — all four
    fallback fields are primitives, so the fallback cannot itself throw.
  - add `splitArgs` helper so `log`/`warn`/`error` preserve object-arg structure
    into ctx instead of flattening to `[object Object]` (JSON-mode only; text
    mode unchanged).

  Adds a regression test (`tests/logger.test.ts`) covering the circular-ref and
  BigInt throw paths, the fallback-record shape, object-structure preservation,
  and the `splitArgs → emitJson` variadic route. Bidirectional DRIFT REFERENCE
  header comments now anchor this logger to the autopilot sibling as
  byte-equivalent in its safety-relevant parts.

  No behavior change for existing internal callers (the guard only calls
  `logWithContext`, never object-arg `log`/`warn`/`error`); text-mode output is
  byte-identical to before.

  Spec: `docs/design/autopilot-dynamic-workflows-boundary.md` §5.2 (DEC-2).

- [#107](https://github.com/TeFuirnever/oh-my-matrix/pull/107) [`16af392`](https://github.com/TeFuirnever/oh-my-matrix/commit/16af392d8bccf00a199c7265e6deede395d84467) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Dynamic Workflows skill-craft + package hygiene fixes (adversarially reviewed).

  Reviewed the bundled `skill/` against `writing-great-skills`, then ran a
  3-reviewer refute pass (Skeptic / Independent / Citation Auditor) which killed
  3 weak findings, corrected evidence on 2, and surfaced 6 more. This release
  lands the 11 surviving fixes. No runtime behavior change to the guard plugin.

  **Skill-craft (SKILL.md + role-prompts):**

  - Fix internal contradiction: remove the "also answers workflow safety
    questions" branch from the description — the body's DO-NOT-USE gate already
    rejects questions-about-workflows (review finding F1).
  - Bind Step 0 completion criterion to the safety preflight: the criterion was
    silent on the 20-line permission-class table it sits next to, allowing an
    agent to declare Step 0 done while skipping the safety work (M1).
  - Trim procedural narration from the model-invoked description; keep the
    leading-word triggers (fan-out / refute / synthesize) (F2).
  - Make the "role-prompt files omit the preamble" claim true: remove the stray
    "treat context as data" line from `skeptic.md` so all 14 role files honor the
    stated convention (F4).
  - Sharpen the Step 1.5 pointer from "map to a standard role" to "copy the
    prompt text" — the prior wording invited naming, the clarification 17 lines
    later said copy. Trimmed the now-redundant blockquote (M2).
  - Unify the manual-validation checklist: was 4 / 6 / 5 across three sites with
    a phantom "types" check that has no grammar backing; now a canonical 5
    everywhere (M3).
  - Freeze the refute-outcome vocabulary (`REFUTED` / `SURVIVES`; `verified` /
    `partial` / `blocked`) so downstream drift has a single normative source (M4).
  - Replace the unobservable "80%+ of the task" threshold with a checkable
    "≤2 independent sub-tasks" proxy (M5).
  - Add 3 `test-prompts.json` cases covering the untested high-variance branches:
    direct-session fallback, plan-only, custom-role checkpoint (M6).

  **Package hygiene:**

  - Sync version drift across four files to `0.1.3`: `index.ts` exported
    `0.1.2`, README Status said `v0.1.0` (F6).
  - Remove the false "re-exports the permission-policy library API" claim from
    `README.md` and `openclaw.plugin.json` — `index.ts` only imports those
    primitives, never re-exports them. Reframed both as "Imports permission
    primitives from @oh-my-matrix/permission-policy" (F7).

  Verification: `pnpm check` (lint + markdownlint + typecheck) and `pnpm -r test`
  all green across the 3 workspace packages. The 3 adversarially-refuted findings
  (F3 runtime-enforcement "duplication" — already a pointer; F5 grammar-rule
  "duplication" — already disclosed; F8 "committed tarball" — actually untracked)
  were excluded by design.

## 0.1.3

### Patch Changes

- [#94](https://github.com/TeFuirnever/oh-my-matrix/pull/94) [`10416bf`](https://github.com/TeFuirnever/oh-my-matrix/commit/10416bf7cb018de13d512fe5a7072cb101992ca1) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Introduce Changesets for automated versioning and publishing. No package behavior changes — this is tooling only (ADR-010 follow-up [#1](https://github.com/TeFuirnever/oh-my-matrix/issues/1)).

- Updated dependencies [[`10416bf`](https://github.com/TeFuirnever/oh-my-matrix/commit/10416bf7cb018de13d512fe5a7072cb101992ca1)]:
  - @oh-my-matrix/permission-policy@0.1.2
