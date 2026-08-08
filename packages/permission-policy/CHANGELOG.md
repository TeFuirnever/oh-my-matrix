# @oh-my-matrix/permission-policy

## 0.1.4

### Patch Changes

- [`5a42ab4`](https://github.com/TeFuirnever/oh-my-matrix/commit/5a42ab419511c4d226c6fb09c3deaebe338a7da8) - Extract the shared structured logger (log/warn/error/logWithContext) from the per-package duplicates in autopilot + dynamic-workflows. The old per-package env var names remain accepted: level resolves AUTOPILOT_LOG_LEVEL → DYNAMIC_WORKFLOWS_LOG_LEVEL → LOG_LEVEL (first set wins); format is json if either AUTOPILOT_LOG_FORMAT or DYNAMIC_WORKFLOWS_LOG_FORMAT is 'json'. In a single process that sets only one package's vars (the normal case), behavior is unchanged from that package's original logger.

## 0.1.3

### Patch Changes

- [#111](https://github.com/TeFuirnever/oh-my-matrix/pull/111) [`91731a2`](https://github.com/TeFuirnever/oh-my-matrix/commit/91731a2cded486888cec1be7c4a3cb92f5158a6a) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Publish accumulated security hardening since 0.1.2 (S12 / B8 / B4-B7 / B3 / B9 + classifier evasions).

  `@oh-my-matrix/permission-policy` has been at 0.1.2 on the npm registry while
  multiple security fixes landed on `master` without a release. This changeset
  rolls them up into a patch release so consumers (and the upcoming
  `@oh-my-matrix/dynamic-workflows@0.1.4`) pick up the hardened command
  classification + audit path.

  Highlights since 0.1.2:

  - **S12** — resolve symlinks in the audit log path before writing (`[#87](https://github.com/TeFuirnever/oh-my-matrix/issues/87)`).
  - **B8** — classify `git checkout -f` / `--force` as `destructive_git` (`[#84](https://github.com/TeFuirnever/oh-my-matrix/issues/84)`).
  - **B4 / B6 / B7** — close destructive-git classifier gaps (`[#82](https://github.com/TeFuirnever/oh-my-matrix/issues/82)`).
  - **B3** — close `bash -c` shell-substitution bypass; **B9** — close
    `segments === 0` unknown-class bypass (`[#56](https://github.com/TeFuirnever/oh-my-matrix/issues/56)`).
  - Close `classifyCommand` evasion paths, shell-substitution + wrapper-exec
    evasion, and the audit-persister bugs surfaced during the security audit.

  No API change — these are classifier-correctness and audit-path fixes. Bump
  type `patch` per CONTRIBUTING.md (bug fix, no new API).

  Required for a clean `./scripts/publish.sh` run: the publish script enforces
  that all three packages be version-ahead of the registry simultaneously, and
  `dynamic-workflows@0.1.4` peer-depends on a hardened `permission-policy`.

## 0.1.2

### Patch Changes

- [#94](https://github.com/TeFuirnever/oh-my-matrix/pull/94) [`10416bf`](https://github.com/TeFuirnever/oh-my-matrix/commit/10416bf7cb018de13d512fe5a7072cb101992ca1) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Introduce Changesets for automated versioning and publishing. No package behavior changes — this is tooling only (ADR-010 follow-up [#1](https://github.com/TeFuirnever/oh-my-matrix/issues/1)).
