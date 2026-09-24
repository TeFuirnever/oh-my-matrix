---
"@oh-my-matrix/permission-policy": patch
---

Classify `write`/`edit` as workspace_write, and fix the subagent write fence: symlink false-positives, decoy path params, and unintrospectable patch tools

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
