# Skill Lifecycle Contract

> Canonical lifecycle conventions and pipeline patterns for omm SKILL.md files.
> Date: 2026-05-08

This document defines the **shared lifecycle contract** that every omm skill follows, plus the **3-phase pipeline pattern** used by skills that produce a single artifact (omm-docs, omm-ui, and future siblings).

Each SKILL.md should reference this contract instead of restating the lifecycle conventions verbatim.

---

## §1 Lifecycle Conventions (all skills)

Every omm skill — regardless of internal phase shape — follows these conventions.

### 1.1 State key

Each skill owns a state key matching its short name (the part after `omm-`):

| Skill | State key |
|-------|-----------|
| omm-docs | `docs` |
| omm-ui | `ui` |
| omm-ultraqa | `ultraqa` |
| omm-deep-interview | `deep-interview` |
| omm-ralph | `ralph` |
| omm-autopilot | `autopilot` |
| omm-team | `team` |

State is persisted via `omm_state_write` and read via `omm_state_read`. The full state file lives at `{stateRoot}/state/{key}.json`.

### 1.2 Initialize

On entry, write initial state:

```json
{
  "mode": "<state-key>",
  "active": true,
  "current_phase": "<first-phase>",
  "status": "running",
  "startedAt": "<ISO8601>",
  ...skill-specific fields
}
```

Skill-specific fields go alongside the standard ones — there is no nested envelope. The state schema is open to additional keys as long as the standard ones are present.

### 1.3 Agent persona loading

When a phase needs a specialized persona, load via:

```
omm_agent_prompt_get({ name: "<agent-name>" })
```

Valid agent names live in `CONTEXT.md` Agent Inventory. The skill MUST cite which agent each phase uses.

### 1.4 Phase transitions

On every phase boundary, persist via:

```
omm_state_write({
  key: "<state-key>",
  value: { ...prevState, current_phase: "<next-phase>", ...updates }
})
```

The `prevState` spread is required — `omm_state_write` does NOT merge; it replaces the file content.

### 1.5 Terminal markers

When the skill finishes, mark the run terminal:

```
omm_state_write({
  key: "<state-key>",
  value: {
    ...prevState,
    status: "complete",     // or "failed" or "blocked"
    active: false,           // required for terminal phases
    completedAt: "<ISO8601>"
  }
})
```

Terminal status values: `complete`, `failed`, `blocked`. All require `active=false`. The plugin's `validateStateWrite` enforces this on write.

### 1.6 Output

Each skill MUST report at completion:

1. The artifact path (or paths) produced
2. The state file path (`{stateRoot}/state/{key}.json`)
3. A short summary (target + outcome + verification stats)

---

## §2 3-Phase Pipeline Pattern

Used by skills that produce a single artifact via a discover → generate → verify shape.

**Current users**: `omm-docs`, `omm-ui`. **Future candidates**: `omm-research` (discover sources → synthesize → verify citations), `omm-refactor` (analyze → transform → verify tests still pass).

### 2.1 When to use this pattern

Use the 3-phase pipeline when ALL of the following hold:

- The skill produces a single artifact (a file, a doc, a transformed code surface)
- Producing it requires research/discovery FIRST (cannot be a one-shot generate)
- The output requires programmatic verification (compile / run / lint / link-check)
- Phases run sequentially; no inner loops or branching

If any of these fails, design a custom phase shape (see omm-ultraqa for a 5-step cycle, or omm-deep-interview for an interview loop).

### 2.2 Phase contract

Each phase has a clear input/output contract.

| Phase | Input | Output | Agent |
|-------|-------|--------|-------|
| **Discover** | `target` (skill argument) | Findings persisted to state (sources, framework, direction) | Skill-specific specialist (document-specialist for docs, designer for ui) |
| **Generate** | Discover findings | Artifact file written; `output_path` persisted to state | Same agent (or a sibling like writer) |
| **Verify** | Artifact path | `verification` block in state; loop back to Generate on failure | Model-driven (no agent), uses Bash + Grep + Read |

### 2.3 State schema template

Skills following the 3-phase pattern persist the following:

```json
{
  "mode": "<state-key>",
  "active": true,
  "target": "<input target>",
  "target_kind": "<discriminant>",
  "output_path": null,
  "current_phase": "discover",      // or "generate" or "verify"
  "discover_findings": null,         // populated after Phase 1
  "artifact": null,                   // populated after Phase 2
  "verification": null,               // populated after Phase 3
  "status": "running",
  "startedAt": "<ISO8601>"
}
```

After verification passes:

```json
{
  ...,
  "status": "complete",
  "active": false,
  "completedAt": "<ISO8601>"
}
```

If verification fails twice in a row, set `status: "blocked"` and surface the unresolved issues to the orchestrator.

### 2.4 Override checklist for SKILL.md authors

When writing a 3-phase skill, the SKILL.md should specify ONLY:

- [ ] **Frontmatter** — name, description, version, user-invocable, disable-model-invocation
- [ ] **Usage** — CLI form with `<target>` shape (e.g., `component <path>`, `spec <topic>`)
- [ ] **Purpose** — one paragraph: what this skill produces and why
- [ ] **Output Targets** — table mapping `target_kind` → output path convention
- [ ] **Phase 1 (Discover) overrides** — which agent to load, what findings to capture, what skill-specific decisions to make (e.g., aesthetic direction for omm-ui, source citations for omm-docs)
- [ ] **Phase 2 (Generate) overrides** — which agent (often same as Phase 1), what artifact shape, refusal policy for unsupported requests
- [ ] **Phase 3 (Verify) overrides** — what programmatic checks to run, what counts as failure, what slop patterns to scan for
- [ ] **Out-of-scope** — explicit non-goals
- [ ] **Trade-offs** — design decisions worth recording

The SKILL.md should NOT restate:

- §1 Lifecycle Conventions (state init, agent loading, terminal markers)
- §2.1 When to use the pattern
- §2.2 Phase contract table
- §2.3 State schema template

Reference this contract instead: `Follows the standard 3-phase pipeline (see docs/contracts/skill-lifecycle.md §2).`

---

## §3 Other Phase Shapes (for reference)

Skills NOT following the 3-phase pattern still honor §1 Lifecycle Conventions. They define their own phase shape:

| Skill | Phase shape | Why not 3-phase |
|-------|-------------|-----------------|
| omm-deep-interview | Init → question loop → synthesize | Output emerges from interview rounds, not a single artifact target |
| omm-ultraqa | Run QA → Check → Diagnose → Fix → Record (cyclic, max 5) | Goal is convergence, not single-artifact production; loops are essential |
| omm-ralph | Plan → execute → verify → fix (cyclic) | Outer persistence loop with multiple inner artifacts |
| omm-autopilot | Multi-stage pipeline driven by `Stage[]` plan | Plan-driven, not pattern-driven |
| omm-team | Multi-agent staged pipeline | Concurrent execution, not single-artifact |

---

## §4 Versioning

This contract is at v1 (introduced 2026-05-08). Backward-incompatible changes increment the version.

Skills that depend on this contract should declare the contract version in a comment or frontmatter note (informational, not enforced). Example: `<!-- conforms to docs/contracts/skill-lifecycle.md v1 -->`.

---

## §5 References

- CONTEXT.md `Skill` definition + Agent Inventory
- `omm-packages/omm-plugin/src/omm-state-validation.ts` — terminal-phase enforcement
- `omm-packages/omm-plugin/src/omm-mode-lifecycle.ts` — preferred state-write API for production skills
- `docs/contracts/mcp.md` — sister contract for MCP server URI scheme + capability matrix
