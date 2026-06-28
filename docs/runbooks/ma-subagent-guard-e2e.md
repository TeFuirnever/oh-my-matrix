# Runbook: MA Live E2E — Subagent Guard Verification

> Verify the OpenClaw gateway actually fires the `@openclaw/dynamic-workflows`
> plugin's `before_tool_call` (priority 11) on a real OpenProse subagent's
> destructive tool call, and hard-blocks it.
>
> **Context:** Component tests are green (`packages/dynamic-workflows/tests/`,
> `packages/permission-policy/tests/`), and shipped artifacts are verified
> (`resources/claw-plugin/dynamic-workflows/dist/index.js` has the guard + priority 11;
> `resources/claw-plugin/autopilot/dist/index.js` has zero guard references). This
> runbook covers the ONE verification those can't: the live gateway hook fire in a
> running MA. See [ADR-011](../adr/011-runtime-workflow-guard.md),
> [ADR-012](../adr/012-dynamic-workflows-plugin-extraction.md),
> [ADR-013](../adr/013-permission-policy-library.md).

## 0. Deploy the guard (build + sync dist to MA)

After any change to `packages/{permission-policy,dynamic-workflows,autopilot}`:

```bash
bash scripts/sync-to-ma.sh   # builds all 3 + cp dist → MA node_modules + resources/claw-plugin
```

Smoke-verify the DEPLOYED dist (bypasses the MA UI / main-session agent, which
declines to dispatch destructive ops to subagents in practice):

```bash
node scripts/verify-guard.cjs   # exits 0 if all expected blocks fire
```

Expect: `destructive` / `cd && git reset --hard` / `rm -rf` / `git push --force` /
`echo $(rm)` / `npx rm` → block; `git status` / main-session → allow.

> Why this exists: the 2026-06-28 placebo bug shipped because tests used a fictional
> event shape. `verify-guard.cjs` require()s MA's actual loaded dist, so a deploy drift
> (e.g. missing permission-policy lib dist) surfaces as a crash here, not silently.

## 1. Launch MA + confirm plugins load

```bash
cd MatrixAssistant && pnpm dev
```

In the startup log, confirm:
- `resources/claw-plugin/{autopilot,dynamic-workflows}` are scanned + loaded (no
  "plugin not loaded" / "Cannot find module" / `@omm` errors).
- `@openclaw/permission-policy` is in `node_modules` (the library both plugins require
  at runtime).

Sanity check (in the MA session, ask the agent):
> What is autopilot's status?

A response from the `autopilot.status` gateway method confirms the plugin layer is alive.

## 2. Trigger a destructive-git subagent

Ask the agent to run a dynamic-workflow where one branch deliberately does destructive
git. Minimal trigger:

> Use the dynamic-workflows skill to run a workflow: fan out two subagents — one
> executes `git reset --hard HEAD~1`, the other executes `git status`. Report each
> result.

**Expected behavior:**
- The `git reset --hard` subagent → **hard-blocked at the gateway** (tool does not
  execute; the agent receives `blockReason`).
- The `git status` subagent → **executes normally** (read-only is allowed).

## 3. Verify the block fired

**(a) MA main-process log** (the `pnpm dev` terminal, or the packaged app's log file).
Grep for:

```
before_tool_call BLOCKED (subagent guard)
```

Expect a line like:

```
[info] before_tool_call BLOCKED (subagent guard) sessionKey=agent:main:subagent:... toolName=git reason=Destructive git command blocked: reset --hard HEAD~1
```

**(b) Audit file** (under the workspace root):

```bash
cat .autopilot/audit-$(date +%Y-%m-%d).jsonl | grep 'subagent:'
```

Expect an entry with `"runId":"subagent:agent:main:subagent:..."` and
`"outcome":"block"`.

## 4. Pass criteria

- [ ] Destructive-git subagent blocked (log **and** audit evidence).
- [ ] Read-only subagent executes normally.
- [ ] Main session unaffected — `git status` directly in the main session is not blocked.

## 5. Edge cases (optional, while you're there)

- **Escape hatch:** start an autopilot run with `WORKFLOW.md`
  `destructive_git.allow: true` and cwd inside the workspace → that run's destructive
  git is **allowed** (the guard only fires on `:subagent:` sessions; autopilot runs are
  main-session, so the guard skips them and autopilot's run-scoped handler allows it).
- **Credential access:** a subagent attempting credential access → blocked
  unconditionally.

## 6. If the block did NOT fire (regression triage)

Check in order:
1. `resources/claw-plugin/dynamic-workflows/dist/index.js` contains
   `BEFORE_TOOL_CALL_PRIORITY = 11` and the `:subagent:` detection? (Component-level:
   should be yes.)
2. Does the spawned subagent's `sessionKey` contain `:subagent:`? OpenProse-spawned
   child sessions should. If the convention changed, `isSubagentSessionKey` in
   `packages/dynamic-workflows/index.ts` needs updating.
3. Is the plugin actually loaded? (No `dynamic-workflows` load record in MA startup →
   check `MatrixAssistant/electron/utils/init-default-plugins.ts` registration +
   `ensurePluginAllowed('dynamic-workflows')`.)

## References

- Implementation: `packages/dynamic-workflows/index.ts` (guard), `packages/permission-policy/` (primitives).
- Decision history: ADR-011 (guard shipped in autopilot) → ADR-012 (extracted to dynamic-workflows plugin) → ADR-013 (primitives extracted to neutral lib).
