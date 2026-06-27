# Fix Spec: Runtime Guard Event-Shape Bug (fail-open in production)

> **Status: NOT STARTED.** Surfaced by adversarial code review 2026-06-27.
> The shipped runtime guard (ADR-011→012→013) is a **placebo in production** — it
> reads event fields that do not exist on the real OpenClaw event, so it fails OPEN
> (allows destructive ops) instead of closed. Tests pass only because they use a
> fictional event shape the host never emits.
>
> This spec is the handoff for a fresh session to execute (the originating session
> ran out of context). Self-contained — no prior conversation needed.

## The bug (verified, feature-breaking)

The OpenClaw `before_tool_call` event type is (`openclaw/src/plugins/hook-types.ts:469-473`):

```ts
type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;     // OBJECT — there is NO `args` array field
  toolKind?: PluginHookToolKind;       // PluginHookToolKind = "code_mode_exec" (the ONLY value)
  derivedPaths?: ...;
};
```

But the guard reads `event.args` + `event.toolKind` as if they were the autopilot-internal shape:

- `packages/dynamic-workflows/index.ts:83` — `Array.isArray(event.args) ? event.args : []` → at runtime `event.args` is `undefined` → always `[]`.
- `packages/autopilot/index.ts` (the run-scoped `before_tool_call` handler, ~lines 579/587) — same `event.args` bug (pre-existing, came from MA's autopilot).
- `classifyCommand(toolName, [], toolKind)` then runs against an **empty arg list** → most commands fall through to `unknown`/`safe_git` → **allow**.

Compounding: every test in `packages/dynamic-workflows/tests/subagent-guard.test.ts` + `packages/autopilot/tests/permission-wiring.test.ts` feeds `{ toolKind: 'destructive_git', args: ['reset','--hard',...] }` — values **the host never emits** (`toolKind` is only ever `"code_mode_exec"`). So the tests are green lies: they assert blocking against a fictional shape that cannot occur in production.

**Net: in production, a subagent running `git reset --hard` (or `rm -rf`, `git push --force`) is NOT blocked.** The `enabled:false` warning is the only honest log line in the package.

### Origin

PRE-EXISTING — not introduced by the ADR-013 decouple. The `event.args`/`classifyCommand(args[0])` logic came from MA's autopilot (`be05e49 feat(omm): add packages/autopilot — migrate from MA`). The Design 2 guard (ADR-011) inherited it; the extraction (ADR-012) + decouple (ADR-013) moved it without fixing the plumbing. The repeated "MA live e2e is the last verification" deferral is exactly what let this survive.

## The real `params` shape (head start for the investigation)

The fix requires knowing what's actually IN `params` per tool type. Confirmed so far:

- **Shell/exec tools** — `params.command` is a **string** (e.g. `openclaw/src/agents/bash-tools.exec.ts:997` `params.command`, `:1326`, `:1410`). Tokenize it to get command + args. `toolName` is the exec tool name (verify exact value).
- **`toolKind`** — only `"code_mode_exec"`. Useless for destructive-vs-safe classification. Drop it from the classifier; classify by `toolName` + parsed command only.

### Investigation the fresh session MUST do first (before writing fix code)

Survey the real `params` shape across ALL tool types the guard will see in a subagent session:

1. **bash/exec tool** — read `openclaw/src/agents/bash-tools.exec.ts` + the tool-definition adapter. Confirm `params.command` (string) + the exact `toolName`. Check for `params.interpreter`, `params.args`, env/cwd fields.
2. **apply_patch / file-write tools** — what's the params envelope? (`openclaw/src/agents/agent-tool-definition-adapter.ts:174` hints at "exec params may contain command credentials".)
3. **MCP tools** — `toolName` like `mcp__<server>__<tool>`? What's in params? Does the classifier need to handle these (or are they out of scope for destructive-git)?
4. **The dispatch** — `openclaw/src/agents/agent-tools.before-tool-call.ts` (how `runBeforeToolCall` builds the event the handler receives). Confirm the handler gets exactly `PluginHookBeforeToolCallEvent` (no adapter adds `args`).
5. **A real subagent tool call** — if possible, capture an actual `before_tool_call` event from a running MA subagent (log `JSON.stringify(event)` once) to confirm the shape empirically. This is the ground truth that the fictional tests lacked.

Record the findings in this spec (append a "## Params-shape survey" section) before writing fix code.

## Fix plan

### 1. `extractCommand(event)` — normalize params → command

New helper in `packages/permission-policy/src/permission-policy.ts` (or a new `extract.ts`):

```ts
// Returns the parsed argv for classification. For shell tools, params.command is a
// shell string — tokenize (respect quoting). For non-shell tools, return [] and let
// toolName-only classification decide.
export function extractCommand(event: { toolName: string; params: Record<string, unknown> }): string[] {
  // shell/exec: params.command is a string
  const cmd = event.params?.command;
  if (typeof cmd === 'string') return tokenizeShell(cmd); // reuse existing tokenize if present, else minimal splitter
  // apply_patch / MCP / file tools: no argv — classify by toolName
  return [];
}
```

Handle the tool-type branching per the survey. Keep it defensive (`params` shape varies).

### 2. Rewire the guards to use `extractCommand` + drop `toolKind`

- `packages/dynamic-workflows/index.ts` — replace `Array.isArray(event.args) ? event.args : []` with `extractCommand(event)`. Remove the `event.toolKind` read. Pass parsed command to `decidePermission`.
- `packages/autopilot/index.ts` (run-scoped handler) — same fix (it has the identical `event.args` bug).
- `decidePermission` / `classifyCommand` — drop reliance on `toolKind` (always `"code_mode_exec"`); classify by `toolName` + parsed command only.

### 3. Harden `classifyCommand` for the subagent threat model

The reviewer found these evasion paths (probed against the current classifier) — ALL currently classify as allow:

| input | current class | → outcome | fix |
|---|---|---|---|
| `find . -delete` / `find / -delete` | `read_only` | allow | `find` with `-delete`/`-exec` → `workspace_cleanup`/block |
| `git checkout .` / `git checkout HEAD file` (no `--`) | `safe_git` | allow | `checkout` discarding workdir → destructive |
| `git push --force` / `--force-with-lease` | `network` | allow | force-push → destructive_git |
| `git branch -D` / `git tag -d` / `git stash clear` | `safe_git` | allow | branch/tag/stash deletion → destructive |
| `git commit --amend` / `git rebase` | `safe_git`/`unknown` | allow | history rewrite → destructive |
| `git reset -HARD` (abbreviation) / `git -c x=y reset --hard` (global flag before subcommand) | `safe_git`/`unknown` | allow | normalize abbreviations + strip leading global git flags before reading subcommand |

Also: **invert the default for untrusted (subagent) sessions.** `permission-policy.ts:280-284` currently does "unclassified = allow" (rationale: avoid "Approval timed out" in autopilot's trusted main session). For the subagent guard, pass a `defaultDeny: true` flag so unclassified → block. Autopilot's run-scoped path keeps allow-by-default (trusted).

### 4. Rewrite tests against REAL event shapes

Replace fictional `{toolKind:'destructive_git', args:[...]}` with real `{toolName:'<exec>', params:{command:'git reset --hard HEAD~1'}, toolKind:'code_mode_exec'}`. The guard must parse `params.command` + block. Add tests for each evasion path in §3.

Add at least one test that constructs a literal `PluginHookBeforeToolCallEvent` (the real type) — if it type-errors against the openclaw type defs, the fictional shape is caught at compile time.

### 5. P2 cleanups (ride along)

- `.gitignore`: add `dist/` (or `packages/*/dist/`). Currently dist is committed (stale-build risk). `git rm -r --cached packages/*/dist`.
- `packages/dynamic-workflows/openclaw.plugin.json`: description still says "exports permission primitives" — they moved to `@openclaw/permission-policy`. Fix.
- `packages/{dynamic-workflows,permission-policy}/tsconfig.json`: `moduleResolution:"node"` deprecated → `"bundler"` or `ignoreDeprecations:"6.0"` (note: the omm workspace's pnpm resolves TS 6.x; verify build works after the change — earlier ignoreDeprecations:"6.0" caused TS5103 in one path; the dynamic-workflows build works WITHOUT it via `pnpm build`).

### 6. Subagent detection (P1, optional in this fix or follow-up)

`isSubagentSessionKey` = `sessionKey.includes(':subagent:')` has no SDK contract. More robust: register the `subagent_spawned` hook to record `childSessionKey` in a `Set`, check that set in `before_tool_call`. At minimum, pin the `:subagent:` format in an ADR + add a test that breaks loudly if it changes. (Lower priority than the P0 event-shape fix — the guard must work AT ALL first.)

### 7. Silent degradation (P1)

Host-level plugin load failure → no warning (register never runs). Consider a load-time heartbeat (`.guard-alive` written on register, checked by a sibling). At minimum, document the gap in the ADR + the runbook's triage section.

## Acceptance criteria

- [ ] `extractCommand` parses `params.command` (shell string) → argv correctly.
- [ ] A test with REAL event shape `{toolName, params:{command:'git reset --hard HEAD~1'}, toolKind:'code_mode_exec'}` → guard returns `{block:true}`.
- [ ] Every evasion path in §3 has a test + is blocked.
- [ ] Subagent path uses `defaultDeny:true` (unclassified → block); autopilot run-scoped path stays allow-by-default.
- [ ] ZERO occurrences of `event.args` or fictional `toolKind` values (`destructive_git`/`credential_access`/`workspace_write`) in source OR tests.
- [ ] `grep -rn "event.args\|toolKind.*destructive\|toolKind.*credential" packages/` → empty.
- [ ] **Live MA e2e** (`docs/runbooks/ma-subagent-guard-e2e.md`) PASSES: a real OpenProse subagent issuing `git reset --hard` → hard-blocked at the gateway (log + audit). This is the test the fictional unit tests replaced — it must actually run this time.
- [ ] 641+ tests green (the rewritten tests + existing).

## Verification mindset

The prior work failed because tests used a fictional event shape. The fix's correctness hinges on the **params-shape survey** (§ investigation) being empirical, not assumed. If unsure about a tool's params shape, LOG a real event from a running MA subagent rather than guessing. One captured real event > ten assumed shapes.

## References

- Adversarial review (2026-06-27): the full finding list (event.args, toolKind, classifier evasion, subagent detection, silent degradation, dist-in-git, etc.).
- Bug origin: `be05e49` (migrate autopilot from MA) — the `event.args`/`classifyCommand(args[0])` logic is pre-existing from MA.
- OpenClaw types: `openclaw/src/plugins/hook-types.ts:450,469-473` (`PluginHookToolKind`, `PluginHookBeforeToolCallEvent`).
- Shell params: `openclaw/src/agents/bash-tools.exec.ts:997,1326,1410` (`params.command`).
- Files to fix: `packages/dynamic-workflows/index.ts`, `packages/permission-policy/src/permission-policy.ts`, `packages/autopilot/index.ts`, `packages/dynamic-workflows/tests/subagent-guard.test.ts`, `packages/autopilot/tests/permission-wiring.test.ts`.
- ADRs: ADR-011 (guard), ADR-012 (plugin extraction), ADR-013 (lib decouple) — all claim "verified/works"; they need an honest "fail-open until this fix" note.
