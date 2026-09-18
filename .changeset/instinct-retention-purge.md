---
"@oh-my-matrix/instinct": minor
---

Add the 30-day retention purge to the observation store, and gitignore `.instinct/` (ticket-11).

The design (`docs/design/ecc-intake-recommendation.md` §3.1 #1) specifies "10MB rotation /
30-day purge / secret scrub" for the observer; v0.1.0 shipped rotation and scrub only, so
observations accumulated forever.

- **`purgeExpired(workspaceDir, { family?, now? })`** drops entries older than 30 days from a
  JSONL file family — `observations.jsonl` plus its `observations-N.jsonl` rotations, matched
  exactly so a future `observations-summary.jsonl` family is not scanned as this one. Files
  left empty (including files that were already empty) are deleted, and `.instinct/` is
  removed once its last file is gone. `family` is a parameter because ticket-09 adds a second
  family (`instincts.jsonl`) that has to reuse this path instead of growing a second purge
  implementation; `now` is injectable so tests get a deterministic clock.
- Runs at `session_start`, before recall — not in the observer. The rewrite is O(file) and
  `session_start` fires once per session, while `after_tool_call` fires on every tool call.
- Never throws, matching the `appendObservation` contract: per-file failures are counted via
  `getPurgeFailureCount()` rather than propagating into the hook that triggered the purge.
- **Deliberate data loss:** entries whose age cannot be read are dropped. An unparseable line
  is a partial write that `loadRecentObservations` already skips, but a valid line with no
  numeric `ts` *is* recallable today, so this deletes recallable data on purpose — a record
  whose age cannot be established can never satisfy the 30-day bound, and `appendObservation`
  always stamps `ts`, so such a line is a half-written record or foreign content.
- Rewrites go through a temp file + rename, so a crash mid-purge cannot truncate the
  surviving entries. A `.jsonl.tmp` left by a crashed rewrite is cleared on the next purge:
  its content is a subset of the file it never replaced, and leaving it would pin `.instinct/`
  open forever (not being a data file, it never purges down to empty).

`.instinct/` is now gitignored. Observations are scrubbed, but committing a summary of every
tool call's input and output into repository history was never the intent.
