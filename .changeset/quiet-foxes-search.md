---
"@oh-my-matrix/permission-policy": patch
---

Classify `web_fetch`/`web_search` as network (ADR-021)

Both arrive in subagent tool lists via `coding`-profile inheritance and were
unclassified, so `defaultDeny` blocked every subagent web read — while `curl`
(arbitrary URL, any method) was already classified `network`. A GET-only fetch
and a search query are strictly narrower than `curl`, so they join it.

`browser`, `coding`, `nodes`, and `sdd_activate_workflow` stay unclassified
(blocked in subagent sessions) by the same ADR, each with a recorded reason —
see `docs/adr/021-subagent-tool-policy-matrix.md` for the full matrix and the
MatrixAssistant-side follow-up (its audit plugin still unconditionally
blacklists `web_search` until the consumer removes that entry).
