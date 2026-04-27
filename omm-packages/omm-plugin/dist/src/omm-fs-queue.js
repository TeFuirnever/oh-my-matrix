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
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
const queues = new Map();
/** Serialize fn against any other in-flight withKeyLock(key, …) call. */
export function withKeyLock(key, fn) {
    const tail = queues.get(key) ?? Promise.resolve();
    // Run fn regardless of whether the prior task fulfilled or rejected;
    // we only care about ordering, not propagating errors between calls.
    const next = tail.then(fn, fn);
    const tracker = next.catch(() => undefined);
    queues.set(key, tracker);
    // Best-effort cleanup: drop the entry once it settles, but only if no
    // newer caller has chained on top.
    tracker.then(() => {
        if (queues.get(key) === tracker)
            queues.delete(key);
    });
    return next;
}
/** Test helper: drop all queued state. Not for production use. */
export function __resetKeyLocksForTest() {
    queues.clear();
}
const LOCK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SAFE_FALLBACK = /[^a-z0-9_-]/gi;
function sanitizeForLockFilename(key) {
    if (LOCK_KEY_PATTERN.test(key))
        return key;
    // Defensive — callsites already sanitize, but keep the lockfile name
    // self-contained so a stray separator can never escape `${lockDir}/.locks/`.
    return key.replace(SAFE_FALLBACK, "_").slice(0, 64) || "_";
}
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const POLL_BASE_MS = 50;
const POLL_JITTER_MS = 20;
function jitterDelay() {
    return POLL_BASE_MS + Math.floor((Math.random() * 2 - 1) * POLL_JITTER_MS);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(1, ms)));
}
/** True iff the given pid is currently alive in this OS. Same-host only. */
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        const code = err?.code;
        // EPERM means the process exists but we can't signal it — still alive.
        if (code === "EPERM")
            return true;
        return false;
    }
}
async function readLockMeta(path) {
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid === "number" &&
            typeof parsed.startedAt === "string" &&
            typeof parsed.hostname === "string") {
            return parsed;
        }
    }
    catch {
        /* unreadable / malformed → treat as no metadata */
    }
    return null;
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
export async function withCrossProcessLock(lockDir, key, fn, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const safeKey = sanitizeForLockFilename(key);
    const locksRoot = join(lockDir, ".locks");
    const lockPath = join(locksRoot, `${safeKey}.lock`);
    return withKeyLock(`${lockDir}::${key}`, async () => {
        await mkdir(locksRoot, { recursive: true });
        const deadline = Date.now() + timeoutMs;
        const meta = {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            hostname: hostname(),
        };
        const payload = `${JSON.stringify(meta)}\n`;
        let acquired = false;
        while (!acquired) {
            try {
                const handle = await open(lockPath, "wx", 0o644);
                try {
                    await handle.writeFile(payload, "utf8");
                }
                finally {
                    await handle.close();
                }
                acquired = true;
                break;
            }
            catch (err) {
                const code = err?.code;
                // Windows reports EPERM (not EEXIST) when O_EXCL races on an
                // already-open file; both mean "lock is held, retry".
                if (code !== "EEXIST" && code !== "EPERM")
                    throw err;
                // Inspect the existing lock for staleness.
                let isStale = false;
                try {
                    const st = await stat(lockPath);
                    const age = Date.now() - st.mtimeMs;
                    if (age >= staleMs) {
                        const existing = await readLockMeta(lockPath);
                        if (existing == null ||
                            existing.hostname !== hostname() ||
                            !isPidAlive(existing.pid)) {
                            isStale = true;
                        }
                    }
                }
                catch {
                    // stat failed — file vanished between EEXIST and stat; retry immediately.
                    continue;
                }
                if (isStale) {
                    await unlink(lockPath).catch(() => undefined);
                    continue;
                }
                if (Date.now() >= deadline) {
                    throw new Error(`OMM_E_LOCK_TIMEOUT: ${key}`);
                }
                await sleep(jitterDelay());
            }
        }
        try {
            return await fn();
        }
        finally {
            await unlink(lockPath).catch(() => undefined);
        }
    });
}
//# sourceMappingURL=omm-fs-queue.js.map