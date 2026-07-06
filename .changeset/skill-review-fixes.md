---
'@oh-my-matrix/dynamic-workflows': patch
---

Dynamic Workflows skill-craft + package hygiene fixes (adversarially reviewed).

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
