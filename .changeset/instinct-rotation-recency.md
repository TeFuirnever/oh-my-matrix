---
"@oh-my-matrix/instinct": patch
---

Fix inverted rotation recency in `loadRecentObservations` (#177).

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
