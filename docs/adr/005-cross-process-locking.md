# ADR-005: Cross-Process Locking via O_EXCL Self-Implementation

## Status

Accepted, 2026-04-27.

## Context

ADR-001 establishes omm as a pure OpenClaw plugin with a separate stdio MCP
server process. ADR-003 commits to a zero-runtime-dependency MCP implementation.
The plugin and the three MCP servers (`omm-state`, `omm-memory`, `omm-trace`)
all read and write the same `${stateRoot}` directory, but they run in
distinct OS processes:

- The plugin runs inside the OpenClaw Gateway / host Electron process.
- Each MCP server is spawned by `mcporter` as its own Node.js process.

The hardening shipped in 0.2.1 (`omm-fs-queue.ts`) serializes the
`validate → exclusivity-check → write → rename` window per key, but only
within a single Node process. The CHANGELOG explicitly flagged this:

> Cross-process write races between plugin and MCP server are still
> possible — single-writer-per-stateRoot is the documented invariant.

For commercial-grade desktop deployment we want the invariant enforced
mechanically rather than by documentation. ADR-003 forbids pulling in
`proper-lockfile`, `lockfile`, or any other npm-published dependency.

POSIX advisory locks (`flock(2)`, `fcntl(F_SETLK)`) are not exposed by
the Node standard library, and Windows lacks an equivalent without a
native module — that path violates ADR-001 ("no Rust native modules")
as well.

## Decision

omm implements a cross-process lock manually using only Node.js
built-ins, layered on top of the existing in-process queue:

```
withCrossProcessLock(lockDir, key, fn, { timeoutMs?, staleMs? })
```

- Lockfile location: `${lockDir}/.locks/${sanitize(key)}.lock`.
- Acquisition: `fs.open(path, 'wx', 0o644)` — `wx` translates to
  `O_CREAT | O_EXCL`, which is atomic on every supported filesystem
  (NTFS, APFS, ext4) at the kernel/Win32 layer.
- Lock body: a single JSON line `{ "pid": …, "startedAt": …, "hostname": … }`
  written and `close()`-d before `fn()` runs.
- Release: `fs.unlink` in a `try/finally` so an exception in `fn` still
  drops the lock.
- Same-process re-entrancy: wrapped inside the existing
  `withKeyLock(${lockDir}::${key}, …)` so two awaits in one process do
  not race for the file.
- Stale recovery: if `EEXIST` and the file's `mtime` is older than
  `staleMs` (default 30 s), read the recorded PID; if `hostname` differs,
  or `process.kill(pid, 0)` throws (ESRCH/EPERM=alive), the lock is
  considered abandoned, `unlink`-ed, and the loop retries.
- Polling: `50 ms ± 20 ms` jitter to avoid thundering-herd when two
  callers wake on the same event-loop tick.
- Timeout: `Error("OMM_E_LOCK_TIMEOUT: <key>")` after `timeoutMs`
  (default 5 s).

The implementation lives in `omm-plugin/src/omm-fs-queue.ts` and is
**inlined verbatim** into each of the three MCP servers
(`omm-mcp/src/index.ts`, `omm-mcp-memory/src/index.ts`,
`omm-mcp-trace/src/index.ts`). MCP servers cannot `import` from
`omm-plugin` without violating ADR-003 (would pull a non-bundled
dependency at runtime), so the duplication is the documented cost.

## Consequences

**Positive:**

- Plugin process and MCP server process can no longer last-write-wins
  on the same `${stateRoot}/state/<key>.json`.
- Zero new runtime or dev dependencies — `node:fs/promises`, `node:os`,
  `node:path` cover everything.
- Deterministic failure mode: callers see `OMM_E_LOCK_TIMEOUT` instead
  of a silent corruption when contention exceeds the budget.
- Recoverable from crashes: stale-lock detection means a `kill -9` on
  one process does not permanently brick the stateRoot.

**Negative:**

- 30 s window during which a crash holds the key unreleased to other
  processes — operationally acceptable for desktop single-user but a
  ceiling on multi-tenant deployments.
- Polling, not event-driven: idle contention costs 50 ms per failed
  attempt (vs `inotify`/`ReadDirectoryChangesW` event delivery).
- Lock metadata's PID liveness check works only on the same host;
  cross-host stateRoot sharing (e.g., NFS) cannot detect remote-crashed
  PIDs and must wait the full `staleMs` window.
- Maintenance burden: the inlined MCP copies must stay byte-identical
  to the canonical `omm-fs-queue.ts` implementation. The build smoke
  (`pnpm omm:smoke-mcp`) plus stress test (`omm-stress-cross-process.mjs`)
  guard against drift.

**Failure semantics:**

- Lock acquisition timeout → `Error("OMM_E_LOCK_TIMEOUT: <key>")` propagates
  to the caller. In the plugin tools this surfaces as `omm_state_write
  error: OMM_E_LOCK_TIMEOUT: <key>`. In MCP responses it becomes a
  JSON-RPC `-32000` error.
- Lock metadata corruption → treated as no-metadata; falls through to
  the staleMs/PID liveness check.
- `unlink` failure during release → swallowed; next acquire-attempt
  hits `EEXIST` and resolves via stale logic.

**Windows quirk (added 0.3.0-alpha.2):**

On Windows, racing `O_EXCL` opens emit `EPERM` instead of `EEXIST`
because the previous holder still has the file descriptor briefly open
after `writeFile/close`. The retry loop accepts both error codes; both
mean "lock is held, retry". This is documented in
`omm-fs-queue.ts:144` and the inlined MCP copies.

The Windows EPERM path adds one extra polling cycle (50 ms ± 20 ms)
per contention event, which raises the stress-test P99 from ~65 ms
(Linux/macOS, EEXIST-only) to ~110-160 ms on Windows. The stress
script's P99 budget was raised from 100 ms to 200 ms to reflect this
honestly; the budget still detects pathological contention without
being noise-flake on Windows.

## Alternatives Considered

**`proper-lockfile`** (popular npm package): rejected. Pulling it in
violates ADR-003. It also performs nearly the same `O_EXCL` + stale
detection algorithm, so the dependency cost buys little.

**`async-mutex` / Node-level mutex packages**: in-process only, doesn't
solve the cross-process problem.

**POSIX advisory locks via native addon**: rejected per ADR-001 (no
native modules). Would also need a Windows-specific equivalent.

**SQLite as the storage layer**: would inherit SQLite's WAL-mode locking
for free, but moves omm off the JSON-file storage model documented in
the contracts and the plugin/MCP test suites — out of scope for a P0
hardening pass.

**Single shared mutex process**: requires running an extra long-lived
daemon, contradicting the "no standalone CLI" posture of ADR-001.
