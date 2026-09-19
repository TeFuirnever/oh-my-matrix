---
"@oh-my-matrix/instinct": minor
---

Add the instinct extractor: `instinct_record` tool + two-part recall (ticket-09).

v0.2.0 shipped the memory substrate (observer, purge, recall). The missing half was
extraction — turning what a session learns into a durable pattern. Design (grilled
2026-09-18, in the ticket): the extracting agent calls a tool rather than being
prompt-injected — an agent that calls is confident by construction, and the prompt
route's failure mode (agent ignores the format → silent, unmeasurable loss) never exists.

- **`instinct_record` tool** (registered via `api.registerTool`): parameters
  `{text, scope: 'project' | 'global'}`. Text is secret-scrubbed and truncated like
  observations. `registerTool` missing on the host API degrades to disabled + one
  `console.error`, same posture as missing hook registration. The manifest now declares
  `contracts.tools` — the openclaw registry drops tool registrations that are not
  pre-declared there (verified against the 2026.7.1-2 registry source).
- **`appendInstinct` upserts by exact stored text**: a hit updates `ts` and increments
  `hits` in place instead of appending a duplicate — repeated patterns must not crowd the
  recall section, and `hits` is the observable confidence signal (deliberately replacing
  an agent self-reported confidence score, which carries no information). Dedup ignores
  `scope`: the first recording's scope stands. Same JSONL file-family substrate
  (rotation, temp+rename rewrites, never-throw with failure counters) as observations.
- **Recall is now two independent sections**: raw activity tail ("where the last session
  stopped") + instincts ranked `hits` desc then `ts` desc ("how this project works").
  Different time scales, separately trimmable — `session_start` is a shared-budget surface.
  Instinct records keep a `project` provenance stamp even when `scope: 'global'`, so a
  future promote/evolve phase can cluster across projects without re-labeling.
- **The 30-day purge now covers both families**: `session_start` calls `purgeExpired` for
  `observations` and `instincts` — the `family` parameter ticket-11 added exists for this.

Tool contract details pinned from the openclaw 2026.7.1-2 SDK types
(`AgentTool`: `name`/`label`/`description`/`parameters`/`execute(toolCallId, params)` →
`{content, details}`). The parameters schema is a hand-written JSON-Schema literal, not a
`@sinclair/typebox` import: TypeBox schemas are plain JSON Schema and the package stays
zero-dependency.
