# ADR-007: Goal Mode — Multi-Instance Filesystem-Canonical State

## Context

omm (v0.4.2) supports three singleton workflow modes (ralph, autopilot, team) via `{stateRoot}/state/{mode}.json`. Each mode is a singleton — only one instance of each can be active at a time.

Analysis of oh-my-claudecode (28 capabilities), oh-my-codex (Ultragoal ~70K + Team runtime ~800K), and OpenClaw 5.6 identified goal tracking as the highest-value missing capability. Goals differ from workflow modes in two fundamental ways:

1. **Multi-instance**: A user may track several goals concurrently, each with independent lifecycle state
2. **Intent-oriented**: Goals describe *what* to achieve; workflow modes execute *how*

In addition, the dual-access model (ADR-003) requires that MCP servers running as separate stdio processes can read goal state. ManagedTaskFlow — OpenClaw 5.6's native goal primitive — is only accessible in-process, making it unsuitable as primary storage.

## Decision Drivers

1. **Dual-access model preservation**: MCP servers must read goal state from the filesystem without depending on in-process APIs
2. **Simplicity for v0.1**: Validate the core abstraction (subgoal decomposition, evidence gates, audit trail) before adding platform integration or DAG complexity
3. **Safety by construction**: Cross-process locking, goalId sanitization, field-level size limits, anti-placeholder evidence enforcement

## Decision

**Goal Mode uses filesystem-canonical state files as the sole source of truth in v0.1.**

Goal state lives in `{stateRoot}/goal/{goalId}.json`, accessed by both plugin tools and MCP servers via the same filesystem path. Each goal is an independent file — no singleton restriction, no cross-goal locking beyond per-goal write serialization.

ManagedTaskFlow shadow sync is **deferred to v0.2**. The v0.1 release focuses entirely on the core goal lifecycle abstraction with filesystem-only persistence.

## Alternatives Considered

### Option A: ManagedTaskFlow as primary persistence (REJECTED)

- **Why**: Would break dual-access model — MCP servers can't access ManagedTaskFlow state. omm's MCP servers are foundational to the architecture (ADR-003).
- **When reconsider**: If OpenClaw exposes ManagedTaskFlow state via a filesystem API or MCP endpoint.

### Option B: Extend existing mode lifecycle for goals (REJECTED)

- **Why**: Existing modes are singletons (`startMode("ralph")` writes one file). Goals are multi-instance. Overloading the singleton API creates awkward semantics (e.g., a `goalId` discriminator field inside a singleton state file).
- **When reconsider**: Never — the multi-instance nature of goals is definitional.

### Option C: omm state files canonical, ManagedTaskFlow shadow in v0.2 (CHOSEN)

- **Pros**: Preserves dual-access model, consistent with existing write pipeline patterns (`withCrossProcessLock`, `tmp+rename`), works without OpenClaw running, MCP servers have full visibility, v0.1 stays focused and testable
- **Cons**: No platform-native goal UI in v0.1 (goals visible only via MCP resources and CLI tools), dual persistence risk when v0.2 adds sync

## Architecture

### v0.1: Filesystem-Only

```
┌──────────────────────────────────────────────────┐
│                  {stateRoot}/goal/                │
│                                                  │
│  my-goal.json          my-goal.ledger.jsonl      │
│  ship-feature.json     ship-feature.ledger.jsonl │
│  refactor-auth.json    refactor-auth.ledger.jsonl│
│  ...                                             │
└──────────┬───────────────────────┬───────────────┘
           │                       │
    ┌──────▼──────┐         ┌──────▼──────┐
    │ omm-plugin   │         │  omm-mcp    │
    │ (in-process) │         │ (stdio)     │
    │              │         │             │
    │ omm_goal_*   │         │ omm://goal/ │
    │ tools        │         │ <id> resource│
    └──────────────┘         └─────────────┘
```

### v0.2 (planned): with ManagedTaskFlow Shadow Sync

```
  omm_goal_write → state file (canonical)
                   └→ ManagedTaskFlow (shadow, fire-and-forget)
```

## Consequences

**Positive:**
- MCP servers (`omm://goal/<goalId>`) can read goal state natively — no platform dependency
- Reuses proven patterns: `withCrossProcessLock`, `sanitizeStateKey`, `tmp+rename` atomic writes, `RunOutcome` terminal stamps
- Multi-instance by design — no exclusivity conflicts with workflow modes
- Append-only `ledger.jsonl` provides audit trail and enables state reconstruction
- Subgoal `critical: boolean` allows partial-failure semantics

**Negative:**
- No platform-native goal UI in v0.1 — goals visible only via MCP resources and CLI tools
- v0.2 ManagedTaskFlow sync introduces dual persistence risk (drift between file and flow state)
- Subgoal DAG deferred to v0.2 — v0.1 uses ordered lists with referential `dependsOn` only
- No subagent-based automated gate verification in v0.1 (gates are manual verification)

**Follow-ups (v0.2):**
- ManagedTaskFlow shadow sync with `expectedRevision` tracking
- Subgoal DAG model with DFS cycle detection
- Subagent-based automated gate verification (`test_pass`, `command_success` gate types)
- MCP goal write support (read-only in v0.1)
- Goal reconciliation with platform snapshot
- `omm_goal_delegate` tool for atomic exclusivity check + workflow mode start

## Review History

| Date | Event |
|------|-------|
| 2026-05-25 | Initial plan drafted with 8 phases, DAG subgoals, ManagedTaskFlow sync in v0.1 |
| 2026-05-25 | Adversarial review team (Architect + Critic + Security) found 8 BLOCKERs |
| 2026-05-25 | Plan revised: 5 phases, ordered subgoals, sync deferred, audit trail added, safe write contract |
