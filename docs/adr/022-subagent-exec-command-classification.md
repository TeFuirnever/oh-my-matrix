# ADR-022: Subagent `exec` Command Classification

## Status

Accepted (2026-09-29). Implements the shell-command layer of the subagent
unavailability fixes — the exec-side companion to
[ADR-021](021-subagent-tool-policy-matrix.md)'s tool layer. Draft issue and
live evidence:
[`docs/2026-09-29-omm-subagent-exec-command-classification-gaps.md`](../2026-09-29-omm-subagent-exec-command-classification-gaps.md);
industry alignment:
[`docs/2026-09-29-subagent-permission-parity-industry-research.md`](../2026-09-29-subagent-permission-parity-industry-research.md).

## Context

In `:subagent:` sessions (`defaultDeny: true`, fail-closed on `unknown`),
`exec` had degenerated to a tiny allowlist — safe git, `npm test`, `curl`,
`npm install`. Every practical command failed through three paths:

1. **Bug (A)**: `extractCommandSegments` flagged ANY backtick as shell
   substitution. On PowerShell hosts the backtick is an escape prefix
   (`` `n ``, `` `t ``), so no Windows-host subagent command containing an
   escape could run.
2. **Gap (B)**: interpreters (`node`, `python`, `pip`, `uv`) fell to
   `unknown` — no scripts, no builds, no verification via shell.
3. **Gap (C)**: PowerShell cmdlets (`Get-Item`, `Set-Content`, …) fell to
   `unknown` — basic file operations unavailable on Windows hosts.

The verdict/stance split is unchanged from ADR-021's lineage:
permission-policy supplies caller-blind verdicts; dynamic-workflows supplies
the stance. This ADR extends the verdict layer only.

## Decision

### 1. Interpreters are `network` (allow but audit)

`node`, `python`, `python3`, `pip`, `pip3`, `uv`, and package-manager `dlx`
subcommands classify as `network` — unconditional allow with an audit entry,
in trusted and untrusted sessions alike, same standing as `curl`.

**Accepted residual risk**: an interpreter one-liner (`node -e "…"`) is
arbitrary code execution, allowed-with-audit in subagent sessions. The
name-class fences (workspace_write fence, destructive_git, system_write,
credential_access, shell-feature gate) are therefore bounds on *accidental*
behavior, not on a malicious session that already has an interpreter. Bounds
that remain: the audit JSONL, the OS, and the operator-side
`subagentExtraAllowTools` lever (companion dynamic-workflows issue) for hosts
that want interpreters denied instead. This trade was proposed by the host
diagnostic of 2026-09-12 and is accepted here explicitly.

Two asymmetries recorded as deliberate:

- `bash -c` / `sh -c` payloads stay `unknown` (blocked in subagents) while
  `node -e` is allowed — the split is incoherent linguistically but lands on
  the fail-closed side where it matters (the blocked one).
- Arbitrary code was already reachable pre-ADR via `npm install` postinstall
  scripts (`network`); interpreters widen the convenience, not the ceiling.

### 2. Backtick detection is platform-gated (`detectShellFeature`)

- **POSIX hosts**: any backtick is potential command substitution → strict
  flag (pre-2026-09 behaviour, unchanged).
- **Windows hosts** (`process.platform === 'win32'`, PowerShell semantics):
  a backtick followed by `[a-zA-Z0-9]` (the PowerShell escape set) is benign;
  anything else — quote, `$`, another backtick, whitespace, EOL — is flagged.

Quotes and `$` are deliberately NOT in the Windows escape class: the
quoted POSIX substitution form `` echo "`cmd`" `` would otherwise pass as
read-only `echo` in a subagent session — the review of the first
implementation found exactly that hole, so the escape class is restricted to
alphanumerics and the quoted form is caught on both platforms.

Residuals (all fail-closed or narrow, accepted):

- Win-only, fail-open: a POSIX closing backtick glued directly to a
  letter/digit (`` echo "x`rm -rf /`y" ``) reads as two PS escapes — not
  flagged. PowerShell-native hosts are unaffected; POSIX shells under win32
  (git-bash/WSL) keep this narrow hole.
- Win-only, fail-closed: PS `` `" ``, `` `$ ``, `` `` `` escapes and the
  backtick-at-EOL line continuation are flagged → subagent commands using
  them are blocked. Trusted sessions unaffected.
- POSIX hosts: commands containing `` `n ``-style escapes are flagged
  (strict) → blocked in subagents. Correct strictness for a POSIX shell,
  where backticks really are substitution.

### 3. PowerShell cmdlet families + an argv-level write fence

`Get-Item` / `Get-Content` / `Get-ChildItem` → `read_only`.
`Set-Content` / `Copy-Item` / `New-Item` → `workspace_write` with a NEW
argv-level fence, `resolveWriteTargetsFromArgv`, wired into
`decidePermissionForEvent`'s segment loop: shell segments carry no
`params.path`, so the existing `resolveWriteTargets` fence would fall back
to the session cwd and miss `Set-Content -Path /etc/hosts` from an
in-workspace cwd.

Fence semantics:

- Per-cmdlet parameter tables classify params as target / value / bool
  (single registry — the write-cmdlet set is DERIVED from the table keys, so
  classification and the fence cannot drift). `Copy-Item` fences the
  **destination** only (its `-Path` is a source, i.e. a read), bound to the
  first UNBOUND positional — with a named source, the next bareword is the
  destination.
- PowerShell binding forms are honoured: unambiguous-prefix abbreviation
  (`-Lit` → `-LiteralPath`), attached values (`-Path:x`; `-Path=x` tolerated),
  common parameters (`-Verbose`, `-ErrorAction`, … — value-consuming ones eat
  their bareword), and comma arrays fence **every** element
  (`"a,../escape"` is two paths).
- Anything unanalyzable returns `FENCE_SENTINEL_TARGET` → block under
  `defaultDeny` (the fence also checks sentinel identity explicitly, so a
  root workspace cannot make it fail-open): **unknown or ambiguous**
  dash-parameter (an unlisted one could carry the real target), **leading-`$`
  variable target** (PowerShell expands `$HOME`/`$env:TEMP` before binding),
  and a **targetless write cmdlet** — its real target arrives by pipeline
  input (`Get-Item /etc/hosts | Set-Content -Value x`), which segment
  splitting has already made unanalyzable.
- Wrapper-prefixed cmdlets (`env Set-Content …`, `npx`/`npm exec` + cmdlet)
  resolve through the same wrapper skip the classifier uses, so the fence
  looks up the same effective binary the classifier did.
- `New-Item -Name` contributes a target of its own (Microsoft: Name may carry
  the path of the new item), joined under `-Path` when both are present.
- `Remove-Item` is deliberately NOT classified: `workspace_cleanup` blocks
  even trusted main sessions, which would regress main-session usage;
  `unknown` keeps subagents fail-closed without touching trusted behaviour.

## Consequences

**Positive:**

- Windows-host subagents regain PowerShell basics: reads, multi-line
  `Set-Content` with `` `n `` escapes, copies, file creation — all inside the
  workspace fence.
- Subagents on any host can run scripts/dep installs/builds via interpreters,
  with audit entries.
- The verdict layer stays caller-blind and session-agnostic, matching the
  industry norm documented in the research note (verdicts consistent,
  stances deliberately asymmetric, expansion operator-owned).
- The quoted-substitution and `-LiteralPath` escapes found in review are
  closed with regression tests.

**Negative:**

- The interpreter residual (§1): subagent sessions can execute arbitrary
  code via one-liners. Audited, operator-deniable, and no worse than the
  pre-existing `npm install` ceiling — but it is a real widening and is
  recorded here as the policy decision it is.
- POSIX-host subagents cannot run commands containing PS-style escapes
  (strict backtick flagging); Windows-host subagents cannot use `` `"``,
  `` `$ ``, ``` `` ``` escapes or backtick line continuation. All fail-closed.
- Cmdlet aliases are not classified: `sc` (Set-Content's alias) stays
  `system_write` from the X-6 Windows SCM classification — a pre-existing,
  platform-ambiguous name not changed here; `ni`/`gc`/`cp` fall to `unknown`
  (fail-closed for subagents, allowed in trusted sessions). Full-name usage
  is the documented requirement.
- A quoted parameter value that itself looks like a KNOWN parameter
  (`-Value "-Verbose"` — quotes are stripped before the fence sees the argv)
  is misread as that parameter and fails closed. Post-quote-stripping this
  is unresolvable without a quote-aware tokenizer; blocked, not a hole.
- Pipeline-sourced writes are blanket-blocked (targetless → sentinel) rather
  than analyzed: `Get-Item inws.md | Set-Content -Value x` is blocked even
  though its target is in-workspace. Subagents must name the target
  explicitly. Availability cost accepted for the fail-closed guarantee.

## Revisit conditions

- ~~The companion `subagentExtraAllowTools` operator lever lands in
  dynamic-workflows~~ **Landed (2026-09-29):** the lever now exists as a
  `pluginConfig` key in `@oh-my-matrix/dynamic-workflows`. Direction
  correction from the original wording: it is an **allow** lever (grants
  extra host tool names, additive, audited per grant, refuses
  guard-disarming names at register) — it cannot *deny* interpreters; a
  deployment wanting interpreters denied needs a classifier-level decision
  (revisit §1 then). `highRiskTools` remains the per-name deny lever.
- A `network_read` class with URL/egress allowlisting materializes (ADR-021
  revisit) → interpreters may want a split (`node script.js` vs
  `node -e "<network fetch>"` stays out of scope until then).
- Interpreter payload inspection (AST-level) is explicitly out of scope;
  revisit only if the residual in §1 causes a live incident.
- A Windows host runs subagent shells through git-bash/WSL instead of
  PowerShell → the win32 escape-aware rule needs a host-configurable shell
  override, not a platform guess.

## Related

- [ADR-011](011-runtime-workflow-guard.md) — the guard itself.
- [ADR-013](013-permission-policy-library.md) — the classifier's home.
- [ADR-021](021-subagent-tool-policy-matrix.md) — the tool-layer sibling.
- Implementation: `packages/permission-policy/src/permission-policy.ts`
  (`detectShellFeature`, `POWERSHELL_*_CMDLETS`, `CMDLET_PARAM_TABLE`,
  `resolveWriteTargetsFromArgv`, `FENCE_SENTINEL_TARGET`).
- Tests: `packages/permission-policy/tests/permission-policy.test.ts`
  ("Issue A/B/C" describes, incl. the review's CRITICAL/HIGH regressions).
