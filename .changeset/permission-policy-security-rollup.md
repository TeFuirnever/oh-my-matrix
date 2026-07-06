---
'@oh-my-matrix/permission-policy': patch
---

Publish accumulated security hardening since 0.1.2 (S12 / B8 / B4-B7 / B3 / B9 + classifier evasions).

`@oh-my-matrix/permission-policy` has been at 0.1.2 on the npm registry while
multiple security fixes landed on `master` without a release. This changeset
rolls them up into a patch release so consumers (and the upcoming
`@oh-my-matrix/dynamic-workflows@0.1.4`) pick up the hardened command
classification + audit path.

Highlights since 0.1.2:

- **S12** — resolve symlinks in the audit log path before writing (`#87`).
- **B8** — classify `git checkout -f` / `--force` as `destructive_git` (`#84`).
- **B4 / B6 / B7** — close destructive-git classifier gaps (`#82`).
- **B3** — close `bash -c` shell-substitution bypass; **B9** — close
  `segments === 0` unknown-class bypass (`#56`).
- Close `classifyCommand` evasion paths, shell-substitution + wrapper-exec
  evasion, and the audit-persister bugs surfaced during the security audit.

No API change — these are classifier-correctness and audit-path fixes. Bump
type `patch` per CONTRIBUTING.md (bug fix, no new API).

Required for a clean `./scripts/publish.sh` run: the publish script enforces
that all three packages be version-ahead of the registry simultaneously, and
`dynamic-workflows@0.1.4` peer-depends on a hardened `permission-policy`.
