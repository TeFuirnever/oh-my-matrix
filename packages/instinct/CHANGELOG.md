# @oh-my-matrix/instinct

## 0.2.0

### Minor Changes

- [`cb90175`](https://github.com/TeFuirnever/oh-my-matrix/commit/cb901753737a1192eee38cb97ea7b7e4d89bd93b) - Add the 30-day retention purge to the observation store, and gitignore `.instinct/` (ticket-11).

  The design (`docs/design/ecc-intake-recommendation.md` §3.1 [#1](https://github.com/TeFuirnever/oh-my-matrix/issues/1)) specifies "10MB rotation /
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
    numeric `ts` _is_ recallable today, so this deletes recallable data on purpose — a record
    whose age cannot be established can never satisfy the 30-day bound, and `appendObservation`
    always stamps `ts`, so such a line is a half-written record or foreign content.
  - Rewrites go through a temp file + rename, so a crash mid-purge cannot truncate the
    surviving entries. A `.jsonl.tmp` left by a crashed rewrite is cleared on the next purge:
    its content is a subset of the file it never replaced, and leaving it would pin `.instinct/`
    open forever (not being a data file, it never purges down to empty).

  `.instinct/` is now gitignored. Observations are scrubbed, but committing a summary of every
  tool call's input and output into repository history was never the intent.

### Patch Changes

- [#178](https://github.com/TeFuirnever/oh-my-matrix/pull/178) [`3e8bbda`](https://github.com/TeFuirnever/oh-my-matrix/commit/3e8bbdad67cdddd3e22114cf7c455800278e26b9) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Fix inverted rotation recency in `loadRecentObservations` ([#177](https://github.com/TeFuirnever/oh-my-matrix/issues/177)).

  Once the observation store rotated past 10 MB, recall returned its **oldest**
  entries forever and never opened the rotated file at all.

  Write and read disagreed about which file is newest. `observationsPath` rolls into
  `observations-1.jsonl` only after `observations.jsonl` fills, so `-N` is newer than the base
  file — but `loadRecentObservations` sorted the base file first and `-N` ascending, with a
  comment asserting the opposite ("observations.jsonl is the live (newest) file"). Combined
  with the `out.length >= limit` early break, the base file — full, so holding far more entries
  than `limit` — satisfied the limit on its own and the newer rotations were never read.

  - `familyFileRecencyKey(file, family)` is now the single recency authority (larger = newer,
    base file = 0), ported from `auditFileRecencyKey` in permission-policy, which already
    carries this fix. The suffix is parsed numerically, not lexically, so `-10` outranks `-2`.
    Only the canonical name for a key earns that key: `observations-0.jsonl` and
    `observations-007.jsonl` rank below every member instead of colliding with the base file
    and with `observations-7.jsonl`. This code writes neither, but a restore or an operator can
    leave one, and a collision re-inverts recall.
  - `observationsPath` now appends into the family's **newest surviving** file instead of
    probing upward from the base file. The probe resumed writing to `observations.jsonl`
    whenever a purge left it under `MAX_FILE_BYTES` — by deleting it (every entry expired) or
    merely by rewriting it smaller — while newer rotations survived, putting the newest entries
    in the file recall treats as oldest.
  - The four family helpers (`isFamilyFile`, `familyFileName`, `familyFileRecencyKey`,
    `listFamilyFiles`) moved into their own section ahead of their first caller, since append,
    purge and recall now all share one membership test and one recency order.

  Eleven regression tests in `tests/rotation-recency.test.ts`. They cover the real trigger (base
  file filled past `MAX_FILE_BYTES`, then one append) rather than only hand-placed rotation
  files, and all three traps the reference implementation documents — `-10` vs `-2` asserted
  through `loadRecentObservations` and not only on the key function, and mtime reordering (an
  operator `touch` must not make the base file newest). Plus append-after-purge with the base
  file deleted and with it merely shrunk, and both non-canonical key collisions.
