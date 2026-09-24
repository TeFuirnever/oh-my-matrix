# ADR-021: Subagent Tool Policy Matrix

## Status

Accepted (2026-09-24). Fixes the per-tool policy questions left open by
[PR #188](https://github.com/TeFuirnever/oh-my-matrix/pull/188)'s drift guard:
nine host-declared tool names the classifier had no opinion about, plus the two
web tools inherited from the `coding` profile.

## Context

The subagent guard (`@oh-my-matrix/dynamic-workflows`, `before_tool_call`
priority 11) fail-closes: any tool `classifyCommand` returns `unknown` for is
blocked in `:subagent:` sessions. That is correct as a mechanism, but it made
every policy non-decision invisible — an unclassified name is blocked exactly
like a deliberately denied one. The `write`/`edit` name drift (11 weeks of
silently broken subagent writes) was one instance; MatrixAssistant's
`tools.alsoAllow` carried nine more.

Which names actually matter was smaller than it looked. Of MA's nine:

- `agents_list` — openclaw `SUBAGENT_TOOL_DENY_ALWAYS` (verified in
  openclaw@2026.7.1-2 `dist/agent-tools.policy-*.js`); never reaches a subagent.
- `message` — disabled at spawn by the host.
- `findskill` / `callmcp` / `findtool` — already in MA's
  `tools.subagents.tools.deny`.
- `web_fetch` / `web_search` — not in `alsoAllow` at all; they arrive via
  `coding`-profile inheritance (live capture, guide §2.2) and DO reach
  subagents.

Leaving six genuinely reachable names: `web_fetch`, `web_search`, `browser`,
`coding`, `nodes`, `sdd_activate_workflow`.

## Decision

| Tool | Subagent policy | Class | Rationale |
|---|---|---|---|
| `web_fetch` | **allow** | `network` | GET-only read egress. `curl` — arbitrary URL, any method — is already `network`; a fetch is strictly narrower. Blocking reads while allowing `curl` was incoherent. |
| `web_search` | **allow** | `network` | Same reasoning; narrower still (query, no arbitrary URL). |
| `browser` | **block** | unclassified | Site automation touches cookies/credentials and is not parameter-inspectable at the hook. Not in `coding` profile by default — an operator wanting it for subagents is asking for a trust decision the guard cannot express. |
| `coding` | **block** | unclassified | Two independent reasons: the opencode worker's writes/commands run in a separate process that never reaches `before_tool_call` (classifying it would be an unconditional allow past the whole guard), and its question-broker hangs 600 s awaiting a human subagents don't have. `write`/`edit`/`exec` cover the need. |
| `nodes` | **block** | unclassified | Device-level actuation: camera/photos/screen/location/notifications/invoke (openclaw tool description). Unattended subagents get no cameras. |
| `sdd_activate_workflow` | **block** | unclassified | Classifying it `workspace_write` would be a placebo — it carries no `path` param, so the write fence falls back to cwd and always passes. Activating an SDD workflow is orchestration-layer state the subagent should receive, not self-trigger. |

`network` remains an unconditional allow in both trusted and untrusted sessions;
this ADR does not change that, it extends membership.

### Consumer-side follow-up (MatrixAssistant, not this repo)

MA's `matrixassistant-audit` plugin additionally blacklists `web_search`
unconditionally (`blacklist.tools`, all sessions). With this ADR the classifier
allows it, but the audit layer still blocks it until MA removes that entry —
otherwise the policy change is silently dead on arrival in that host.

## Consequences

**Positive:**

- Subagents regain web read access (fetch docs, search) — the last commonly
  needed capability the guard was silently withholding.
- Every reachable MA tool name now has a recorded decision; the drift guard's
  awaiting-decision set shrinks from nine names to the four stay-blocked ones,
  each pointing here.

**Negative:**

- Subagents gain uncontrolled read egress (same standing as `curl`). Audit
  entries are still written (`network` decisions audit), but there is no
  URL-level gate at this layer; hosts wanting one must add their own hook
  (MA's audit plugin does).
- `web_search` in MA remains blocked until the consumer-side follow-up lands —
  a known cross-repo coupling, documented in the guide addendum.

## Revisit conditions

- A `network_read` class with URL allowlisting materializes → move
  `web_fetch`/`web_search`/`curl` there and fence URLs.
- The `coding` worker ever routes its operations through host tool calls →
  re-evaluate `coding` classification.
- `nodes` grows a read-only `status` subcommand surface worth granting → needs
  param-level classification, not name-level.

## Related

- [ADR-011](011-runtime-workflow-guard.md) — the guard itself.
- [ADR-013](013-permission-policy-library.md) — the classifier's home.
- Guide with 2026-09-24 addendum:
  [`docs/OpenClaw-subagent工具拦截排查与修复全指南.md`](../OpenClaw-subagent工具拦截排查与修复全指南.md)
- Drift guard: `packages/permission-policy/tests/permission-policy.test.ts`
  ("host tool-name coverage").
