import type { PermissionAuditEntry } from './types';
/**
 * Returns YYYY-MM-DD for the given date using LOCAL time (not UTC).
 * Exported for testing; production code uses the private todayString() wrapper.
 */
export declare function _todayStringForTest(d: Date): string;
/**
 * Returns the path for the current audit JSONL file.
 * If the current file exceeds MAX_FILE_BYTES, appends a numeric suffix.
 */
export declare function getAuditFilePath(workspaceDir: string): string;
/**
 * Append a single PermissionAuditEntry to the audit JSONL file.
 * Creates the audit directory and file if they don't exist.
 * Never throws — errors are silently swallowed to avoid disrupting the plugin.
 */
export declare function appendAuditEntry(entry: PermissionAuditEntry, workspaceDir: string): void;
/**
 * Sort key for an audit filename where LARGER = NEWER. Base file `audit-DATE.jsonl`
 * sorts before its same-day rotations (`audit-DATE-1.jsonl`, `-2`, …) because writes
 * roll into `-N` only after the base fills, so `-N` is always newer than the base.
 * Numeric suffix parse (not lexical) so `-10` ranks above `-2`. Exported for tests.
 */
export declare function auditFileRecencyKey(f: string): number;
/**
 * Load the most recent `limit` audit entries from the audit directory.
 * Reads the current day's file (and yesterday's if needed to fill the limit).
 * Skips malformed lines gracefully.
 * Returns entries in chronological order (oldest first).
 */
export declare function loadRecentAuditEntries(workspaceDir: string, limit: number): PermissionAuditEntry[];
//# sourceMappingURL=audit-persister.d.ts.map