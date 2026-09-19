---
"@oh-my-matrix/instinct": patch
---

Truncation-safe dedup identity, from the unified code review's late report.

Dedup matched on the stored text — which is truncated at 500 chars — so two
distinct instincts sharing a 497-char prefix collapsed into one record: the
second was silently never stored while the tool reported success. Records now
carry `hash: sha256(whitespace-normalized raw)[:16]`, and a dedup hit requires
both the stored text and the hash to match. Same text still reinforces; two
different long texts stay separate even when their stored (truncated) forms are
byte-identical.

Also awaits the two floating `execute()` calls in the recall tests (safe today
only because execute happens to be synchronous-to-completion; any future await
inside it would have made them flaky).
