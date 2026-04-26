/**
 * Per-key async serialization queue.
 *
 * Why: state writes go through tmp+rename which is atomic, but two
 * concurrent writers to the same key can still last-write-wins because
 * the validate→exclusivity-check→write→rename sequence is not atomic
 * as a whole. This queue serializes any operation tagged with the same
 * key so the read-modify-write window for one key holds the lock for
 * its full duration.
 *
 * In-process only. Cross-process races (plugin process vs MCP server
 * process writing the same stateRoot) are still possible — single-user
 * desktop deployment is the documented operational model. See
 * architecture.md §"deployment model".
 */

const queues = new Map<string, Promise<unknown>>();

/** Serialize fn against any other in-flight withKeyLock(key, …) call. */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = queues.get(key) ?? Promise.resolve();
  // Run fn regardless of whether the prior task fulfilled or rejected;
  // we only care about ordering, not propagating errors between calls.
  const next = tail.then(fn, fn);
  const tracker: Promise<unknown> = next.catch(() => undefined);
  queues.set(key, tracker);
  // Best-effort cleanup: drop the entry once it settles, but only if no
  // newer caller has chained on top.
  tracker.then(() => {
    if (queues.get(key) === tracker) queues.delete(key);
  });
  return next;
}

/** Test helper: drop all queued state. Not for production use. */
export function __resetKeyLocksForTest(): void {
  queues.clear();
}
