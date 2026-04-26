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
/** Serialize fn against any other in-flight withKeyLock(key, …) call. */
export declare function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
/** Test helper: drop all queued state. Not for production use. */
export declare function __resetKeyLocksForTest(): void;
