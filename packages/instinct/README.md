# @oh-my-matrix/instinct

Cross-session context memory for openclaw hosts. Three surfaces close the loop:

- **Observer** (`after_tool_call`): appends scrubbed `{tool, input, output}` summaries to `.instinct/observations.jsonl` (10 MB rotation, secret-scrubbed).
- **Extractor** (`instinct_record` tool): the main agent records distilled working patterns to `.instinct/instincts.jsonl`. Dedup matches stored text plus a raw-text hash within the same scope class; hit counts are the confidence signal.
- **Recall** (`agent_turn_prepare`): once per session, injects a two-part `appendContext` — recent activity tail plus ranked instincts, each independently trimmable. `session_start` keeps the 30-day retention purge for both families (the host discards its return value; injection only reaches the model from the prompt-injection hooks).

Records are scrubbed before hitting disk; `.instinct/` is workspace-local and should stay gitignored. Promote/evolve across projects is a later phase. Source and design: [oh-my-matrix](https://github.com/TeFuirnever/oh-my-matrix) · `docs/design/ecc-intake-recommendation.md`.
