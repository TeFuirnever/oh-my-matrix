---
name: omm-ui
description: UI artifact generation pipeline — discover, generate, and verify component code, design specs, or theme tokens
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start a UI artifact generation session.

## Usage

```
/omm-ui <target>
```

Where `<target>` follows one of three forms:

| Form | Example | Output type |
|------|---------|-------------|
| `component <path>` | `component src/components/SettingsPanel.tsx` | Framework-idiomatic component file |
| `spec <topic>` | `spec login flow` | Design specification markdown |
| `theme <name>` | `theme dark-mode` | Design tokens (CSS variables / Tailwind config) |

If `<target>` is missing or shape is ambiguous, the skill prompts the orchestrator to clarify before proceeding.

## Purpose

omm-ui orchestrates a 3-phase UI artifact pipeline:

1. **Discover** (designer): detect frontend framework, study existing UI patterns, commit to an aesthetic direction with explicit domain check.
2. **Generate** (designer): produce the requested artifact (component code, spec doc, or design tokens) matching the chosen direction and existing project style.
3. **Verify**: validate the artifact compiles/renders/lints; scan for AI slop (purple gradients on white, generic Inter+Roboto stacks, aimless cream-and-serif on operational UIs).

omm produces **UI artifacts as deliverable files** (per ADR-001). It does NOT render UI itself; the consuming host (e.g., MatrixAssistant) loads the artifacts at its own pace.

## Output Targets

By convention:

| Target type | Output path |
|-------------|-------------|
| `component <path>` | The exact path supplied (must end in `.tsx`/`.vue`/`.svelte`/`.jsx` per detected framework) |
| `spec <topic>` | `docs/design/<slug>.md` |
| `theme <name>` | `design-tokens/<name>.css` (CSS variables) AND/OR `design-tokens/<name>.tailwind.cjs` (Tailwind config fragment) |
| Custom | Caller-specified path |

## Lifecycle

Follows the standard 3-phase pipeline (see `docs/contracts/skill-lifecycle.md` §2). State key: `ui`. Skill-specific overrides below.

### Initialize

Standard 3-phase init (per contract §2.3) with `target_kind ∈ {component, spec, theme}` and additional fields:

```json
{
  "mode": "ui",
  "active": true,
  "target": "<input target>",
  "target_kind": "component | spec | theme",
  "output_path": null,
  "current_phase": "discover",
  "framework": null,
  "aesthetic_direction": null,
  "discover_findings": null,
  "artifact": null,
  "verification": null,
  "status": "running",
  "startedAt": "<ISO8601>"
}
```

### Phase 1: Discover (overrides)

Agent: `designer`. Tasks:

1. **Detect framework**: Read `package.json` to identify React / Next / Vue / Angular / Svelte / Solid. Set `state.framework`.
2. **Study existing UI patterns**: Glob the target directory and 1-2 sibling component files. Read them. Note: component structure, styling approach (CSS modules, Tailwind, styled-components), animation library (Framer Motion, Motion One, native), file naming convention.
3. **Domain check**: Classify the brief into a domain bucket:
   - **Editorial-fit**: editorial / hospitality / portfolio / brand → editorial defaults (cream backgrounds, serif display, terracotta accents) acceptable.
   - **Operational**: dashboard / dev tools / fintech / healthcare / enterprise / data-viz → MUST override editorial defaults with concrete alternative palette (hex codes) and typeface stack.
   - **Ambiguous**: propose 3-4 distinct visual directions (each: bg hex / accent hex / typeface — one-line rationale), select best-fit default for the brief, and proceed. Do not pause for user clarification unless runtime explicitly supports interactive input.
4. **Commit aesthetic direction** in state with `palette`, `typography`, `motion`, `rationale` fields.

### Phase 2: Generate (overrides)

Agent: `designer` (same persona, new phase).

1. Read `framework` + `aesthetic_direction` from state.
2. Generate the artifact based on `target_kind`:
   - **component**: production-grade component file with typed props interface, accessibility (ARIA, keyboard), responsive breakpoints, idiomatic framework primitives, no `console.log`, no commented-out code.
   - **spec**: markdown design spec with sections — Aesthetic Direction, Component Inventory, Interaction Map, Token Reference, Implementation Notes, Open Questions.
   - **theme**: CSS custom properties file AND/OR Tailwind config fragment exporting palette, typography, spacing.
3. **Refuse to invent unrequested features**: stay within scope. Append unresolved facts to `open_questions`.

### Phase 3: Verify (overrides)

Programmatic checks:

1. **Compile / typecheck**: For component artifacts, run repo-native diagnostics via Bash (e.g., `pnpm typecheck`, `tsc --noEmit`). Skip for pure spec/theme markdown.
2. **Lint**: Run repo-native lint (e.g., `pnpm lint`, `biome check`). Errors block; warnings don't.
3. **Render check (optional)**: If a dev server is wired in package.json, launch in background, hit the relevant route, capture HTTP status. Skip if no dev server is configured.
4. **Slop scan**:
   - Editorial-default leakage on operational briefs: grep for `#F4F1EA`, `#FAF5EE`, `Fraunces`, `Playfair`, `Georgia.*serif` — flag if domain check classified as operational.
   - AI slop: purple-to-pink gradients (`from-purple.*to-pink`, `linear-gradient.*purple.*pink`), generic font stacks (`font-family: Inter, Roboto, system-ui`), filler comments (`// TODO: implement`, `// magic happens here`).
5. **A11y minimum** (component artifacts only): grep for missing `alt=""` on `<img>`, missing `aria-label` on icon-only buttons, missing `role` on custom interactive elements.

If any blocking failures, return to Phase 2 (max 2 regeneration cycles before `status: "blocked"`).

## Output

On completion:

1. Artifact file at `<output_path>` (verified)
2. State record at `{stateRoot}/state/ui.json` (with full lifecycle history)
3. Brief summary to the orchestrator: target_kind + output_path + aesthetic_direction summary + verification stats

If verification fails after 2 regeneration cycles, set `status: "blocked"` and surface the unresolved issues to the orchestrator.

## Out-of-scope

- **Rendering UI in omm itself** — omm is a pure plugin (ADR-001); UI artifacts are deliverable files for the host (MatrixAssistant) to load.
- **Animation library installation** — if the artifact references a library not in `package.json`, append to `open_questions`. Do not run `pnpm add`.
- **Cross-component refactoring** — if a generated component requires changes to siblings, list them in `open_questions`. omm-ui is single-artifact-scoped.
- **Backend / API design** — that is `architect` + executor work, not designer.
- **Asset generation** (images, icons, illustrations) — out of scope. Reference assets by path; do not generate.

## Trade-offs

- **Two-pass cost**: discover + generate + verify is more thorough than single-shot UI generation. Worth it because hallucinated component APIs cause integration pain.
- **Domain check is mandatory**: the designer agent's editorial defaults (cream/serif/terracotta) are inappropriate for most omm-host scenarios (typically operational dashboards). Forcing the domain check is intentional friction.
- **No live preview** unless the project already provides a dev server: omm-ui will not start one to keep the skill side-effect-free.
- **Open questions accumulate**: artifacts may ship with `open_questions` rather than guess. Caller resolves them before merge.

## Companion Skills

- `omm-docs` — sister skill for documentation generation. Same 3-phase shape; activates writer + document-specialist instead of designer.
- `omm-ralplan` — use when the UI work needs consensus planning before generation (e.g., multi-component design system).
- `omm-autopilot` — use when the UI work has a fully-specified plan and just needs orchestrated execution.
