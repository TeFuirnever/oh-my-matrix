# @oh-my-matrix/permission-policy

## 0.1.5

### Patch Changes

- [#188](https://github.com/TeFuirnever/oh-my-matrix/pull/188) [`472a53a`](https://github.com/TeFuirnever/oh-my-matrix/commit/472a53a25d98c85f6608219c0be6465bd21cd992) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Classify `write`/`edit` as workspace_write, and fix the subagent write fence: symlink false-positives, decoy path params, and unintrospectable patch tools

  `workspaceWriteTools` listed `write_file` but not `write`/`edit`, which are the
  names the gateway actually sends. Both fell through to the unclassified branch,
  where `defaultDeny` blocks them — so a subagent could not write a file at all.
  They are now classified, which is what puts them behind the fence below.

  The Q4 write fence compared a write target against the workspace without
  accounting for targets that do not exist yet — the normal case when creating a
  file. `realpathSync` throws `ENOENT` on the missing leaf and falls back to a
  lexical resolve, while the workspace (which does exist) resolves fully. On macOS
  a workspace under `/tmp` resolves to `/private/tmp`, so the two disagreed and
  every legitimate new-file write from a subagent was blocked.

  - Add `resolveRealAllowingMissing`, which walks up to the nearest existing
    ancestor, resolves that, then re-appends the missing tail. Both sides of the
    comparison are now symmetric. This also closes the inverse hole: a
    pre-existing in-workspace symlink pointing outside (`/ws/link -> /etc`) is
    resolved even when the leaf under it is missing, so
    `write({ path: 'link/new.txt' })` is correctly fenced out.
  - Replace `resolveWriteTarget` with `resolveWriteTargets`, which returns every
    path-shaped param instead of stopping at the first match. Previously a benign
    `path` could vouch for a `file_path` the host actually wrote to.
  - Add `unintrospectableWriteTools` (`apply_patch`, `apply_diff`). Their targets
    live in the patch body, not a path param, so the fence has nothing to check
    and a `--- a/../../etc/hosts` header escaped the workspace. They are now
    blocked under `defaultDeny` and still allowed in trusted sessions; `write` and
    `edit` cover the same need for subagents.

  Regression coverage uses real directories and real symlinks — the previous tests
  used fabricated paths, where both sides fall back to a lexical resolve and agree,
  which is exactly why the false-positive was invisible.

- [#190](https://github.com/TeFuirnever/oh-my-matrix/pull/190) [`57c612c`](https://github.com/TeFuirnever/oh-my-matrix/commit/57c612c8079f0533ce3b930acf516cff3a024bcc) Thanks [@TeFuirnever](https://github.com/TeFuirnever)! - Classify `web_fetch`/`web_search` as network (ADR-021)

  Both arrive in subagent tool lists via `coding`-profile inheritance and were
  unclassified, so `defaultDeny` blocked every subagent web read — while `curl`
  (arbitrary URL, any method) was already classified `network`. A GET-only fetch
  and a search query are strictly narrower than `curl`, so they join it.

  `browser`, `coding`, `nodes`, and `sdd_activate_workflow` stay unclassified
  (blocked in subagent sessions) by the same ADR, each with a recorded reason —
  see `docs/adr/021-subagent-tool-policy-matrix.md` for the full matrix and the
  MatrixAssistant-side follow-up (its audit plugin still unconditionally
  blacklists `web_search` until the consumer removes that entry).

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
