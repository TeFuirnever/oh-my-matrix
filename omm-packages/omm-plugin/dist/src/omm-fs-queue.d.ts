/**
 * Per-key async serialization queue + cross-process file lock.
 *
 * Why: state writes go through tmp+rename which is atomic, but two
 * concurrent writers to the same key can still last-write-wins because
 * the validate→exclusivity-check→write→rename sequence is not atomic
 * as a whole. This module provides two layers:
 *
 *   1. `withKeyLock(key, fn)` — in-process serialization (per-promise queue).
 *   2. `withCrossProcessLock(lockDir, key, fn)` — cross-process serialization
 *      via `fs.open(path, 'wx')` (O_EXCL). Required because plugin and
 *      MCP servers can run in distinct OS processes that share `stateRoot`.
 *
 * Zero-dep per ADR-003. See ADR-005 for the cross-process design rationale.
 */
/** Serialize fn against any other in-flight withKeyLock(key, …) call. */
export declare function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
/** Test helper: drop all queued state. Not for production use. */
export declare function __resetKeyLocksForTest(): void;
export interface CrossProcessLockOptions {
    /** Max time to wait for the lock before throwing. Default 5000 ms. */
    timeoutMs?: number;
    /**
     * Treat an existing lock file as stale (and reclaim it) if its mtime
     * is older than this AND its recorded PID is not alive. Default 30000 ms.
     */
    staleMs?: number;
}
/**
 * Serialize fn across processes by acquiring an O_EXCL lock file at
 * `${lockDir}/.locks/${sanitized(key)}.lock`. Wrapped in `withKeyLock`
 * so same-process callers don't fight for the file lock.
 *
 * Stale lock recovery: if the lockfile's mtime is older than `staleMs`
 * AND its recorded PID (when local) is no longer alive, the file is
 * removed and acquisition retries.
 *
 * Throws `Error("OMM_E_LOCK_TIMEOUT: <key>")` after `timeoutMs`.
 */
export declare function withCrossProcessLock<T>(lockDir: string, key: string, fn: () => Promise<T>, options?: CrossProcessLockOptions): Promise<T>;
