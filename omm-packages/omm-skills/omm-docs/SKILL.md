---
name: omm-docs
description: Documentation generation pipeline — research, draft, and verify technical documentation
user-invocable: true
disable-model-invocation: false
version: 0.1.0
---

Start a documentation generation session.

## Usage

```
/omm-docs <target>
```

Where `<target>` is one of:

- A relative file path to document (e.g., `omm-packages/omm-plugin/src/omm-state-validation.ts`)
- A topic name (e.g., `MCP capability matrix`, `agent prompt loader contract`)
- A doc-type shorthand: `readme`, `api`, `architecture`, `migration`, `tutorial`

If `<target>` is empty, the skill prompts the orchestrator to clarify scope before proceeding.

## Purpose

omm-docs orchestrates a 3-phase documentation pipeline:

1. **Research** (document-specialist): inspect local sources (code + existing docs), look up external references when needed, capture facts with citations.
2. **Draft** (writer): turn research findings into structured documentation matching the project's existing style.
3. **Verify**: validate every code example runs, every command executes, every link resolves before the doc is considered done.

The pipeline is **separation-enforced** — research and writing are distinct passes by distinct agents. Writer never invents facts; it only renders what document-specialist gathered.

## Output Targets

By convention:

| Target type | Output path |
|-------------|-------------|
| File path | `docs/contracts/<basename>.md` (API contract) or `docs/architecture/<basename>.md` (design) |
| Topic name | `docs/<slug>.md` |
| `readme` | Project root `README.md` (edit) |
| `migration` | `docs/migrations/<YYYY-MM-DD>-<slug>.md` |
| Custom | Caller-specified path |

## Lifecycle

### Initialize

Write state via `omm_state_write` with key `docs`:

```json
{
  "mode": "docs",
  "active": true,
  "target": "<input target>",
  "output_path": null,
  "current_phase": "research",
  "research_findings": null,
  "draft_path": null,
  "verification": null,
  "status": "running",
  "startedAt": "<ISO8601>"
}
```

### Phase 1: Research

Load the document-specialist persona:

```
omm_agent_prompt_get({ name: "document-specialist" })
```

Document-specialist tasks:

1. **Classify the target**: project-specific (read local repo) vs external API/framework (curated docs first, web second).
2. **Gather sources**: Read for local files, Glob/Grep for related code, Bash for git history when version context matters.
3. **Capture findings** as a structured brief:
   - **What it is** (one-sentence summary)
   - **How it works** (entry points, data flow, key invariants)
   - **Inputs/outputs** (signatures, schemas, error modes)
   - **Source citations** with file paths + line ranges (e.g., `omm-state-validation.ts:42-68`)
   - **Open questions** (uncertainties to resolve before drafting)

4. Persist findings to state:

```
omm_state_write({
  key: "docs",
  value: { ...prevState, research_findings: { ... }, current_phase: "draft" }
})
```

### Phase 2: Draft

Load the writer persona:

```
omm_agent_prompt_get({ name: "writer" })
```

Writer tasks:

1. **Read the research findings** from state.
2. **Match existing style**: scan 1-2 sibling docs in the target directory before drafting (use Read).
3. **Write the doc** to the output path with:
   - Headers matching the project's existing scheme
   - Code blocks with language tags
   - Tables for structured data
   - Active voice, direct language, no filler
4. **Refuse to invent**: if findings lack a fact the doc needs, do NOT make it up. Append it to `open_questions` and proceed without it.
5. Persist draft path to state:

```
omm_state_write({
  key: "docs",
  value: { ...prevState, draft_path: "<output_path>", current_phase: "verify" }
})
```

### Phase 3: Verify

Verification tasks (model-driven, no agent persona needed):

1. **Code blocks**: extract every fenced code block. Run executable ones via Bash; flag any that fail.
2. **Commands**: extract every `$ ...` or sentence-form command. Run them; flag failures.
3. **File path references**: confirm every `path/to/file.ts:Line` reference resolves (use Read).
4. **Cross-doc links**: extract every `[...](./...)` link to a relative file; confirm target exists.
5. **Style sanity check**: scan for AI slop (purple prose, generic filler, "delve into", "leverage", etc.).

Capture verification results:

```json
{
  "verification": {
    "code_blocks_run": <count>,
    "code_blocks_failed": <count>,
    "commands_run": <count>,
    "commands_failed": <count>,
    "broken_paths": ["<file:line>", ...],
    "broken_links": ["<href>", ...],
    "slop_flags": ["<line>: <pattern>", ...]
  }
}
```

If any failures, return to Phase 2 with the failed items for re-drafting. If clean, mark the run complete:

```
omm_state_write({
  key: "docs",
  value: { ...prevState, status: "complete", active: false, completedAt: "<ISO8601>" }
})
```

## Output

On completion:

1. Doc file at `<output_path>` (verified)
2. State record at `{stateRoot}/state/docs.json` (with full lifecycle history)
3. Brief summary to the orchestrator: target + output_path + verification stats

If verification fails after 2 redraft cycles, set `status: "blocked"` and surface the unresolved issues to the orchestrator.

## Out-of-scope

- **Code review of the documented code** — that is `code-reviewer`'s job.
- **API design changes** — write existing APIs accurately; do not propose changes here.
- **Marketing copy** — omm-docs is technical documentation only.
- **Translation** — write in the same language as the source code's existing docs (typically English with Chinese cross-references where the project uses both).

## Trade-offs

- **Two-pass cost**: research + draft + verify is more thorough than a single-shot doc generator. Worth it because hallucinated docs are worse than missing docs.
- **Markdown linkcheck depends on Bash/Grep** — no dedicated linkchecker dep (ADR-003 zero-dep posture for any future MCP exposure).
- **Open questions accumulate**: drafts may ship with `open_questions` sections rather than guess. This is a feature, not a bug — caller resolves them before merging.
