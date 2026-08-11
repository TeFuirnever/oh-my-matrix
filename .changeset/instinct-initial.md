---
'@oh-my-matrix/instinct': minor
---

New package: cross-session context memory. after_tool_call observes scrubbed
tool-call summaries to .instinct/observations.jsonl (10 MB rotation, secret
scrubbing, project-scoped by sha256(git remote)[:12]); session_start recalls
the most recent observations as appendContext so a new session resumes with
what the last one did. Skips :subagent: workflow branches. Instinct
extraction (promote/evolve) is a later phase.
