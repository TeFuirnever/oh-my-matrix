/**
 * Audit log persistence for autopilot permission audit entries.
 *
 * Writes PermissionAuditEntry records to JSONL files under
 * {workspaceDir}/.autopilot/audit-{YYYY-MM-DD}.jsonl
 *
 * Design: synchronous file I/O (plugin runs in main process; simplicity > async here).
 * No external dependencies.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { PermissionAuditEntry } from './types';

const AUDIT_SUBDIR = '.autopilot';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
/** Strict audit-file pattern: audit-YYYY-MM-DD(-N)?.jsonl (rotation starts at -1). M1/L1. */
const AUDIT_FILE_RE = /^audit-\d{4}-\d{2}-\d{2}(-[1-9]\d*)?\.jsonl$/;

/** Returns the audit directory path for a given workspace root. */
function getAuditDir(workspaceDir: string): string {
  return path.join(workspaceDir, AUDIT_SUBDIR);
}

/**
 * Returns YYYY-MM-DD for the given date using LOCAL time (not UTC).
 * Exported for testing; production code uses the private todayString() wrapper.
 */
export function _todayStringForTest(d: Date): string {
  return [
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Returns today's YYYY-MM-DD string in local time. */
function todayString(): string {
  return _todayStringForTest(new Date());
}

/**
 * Returns the path for the current audit JSONL file.
 * If the current file exceeds MAX_FILE_BYTES, appends a numeric suffix.
 */
export function getAuditFilePath(workspaceDir: string): string {
  const dir = getAuditDir(workspaceDir);
  const base = `audit-${todayString()}`;
  // Find the right suffix: start at no suffix, increment if file is too big
  let candidate = path.join(dir, `${base}.jsonl`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.size < MAX_FILE_BYTES) break;
    } catch {
      break;
    }
    candidate = path.join(dir, `${base}-${suffix}.jsonl`);
    suffix++;
  }
  return candidate;
}

/**
 * Append a single PermissionAuditEntry to the audit JSONL file.
 * Creates the audit directory and file if they don't exist.
 * Never throws — errors are silently swallowed to avoid disrupting the plugin.
 */
export function appendAuditEntry(entry: PermissionAuditEntry, workspaceDir: string): void {
  try {
    const filePath = getAuditFilePath(workspaceDir);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Fail silently — audit persistence must never crash the plugin
  }
}

/**
 * Parse the `-N` rotation suffix of an audit file; the base file
 * (`audit-YYYY-MM-DD.jsonl`, no suffix) → 0 (it holds the oldest content that
 * day). Higher suffix = written later = newer.
 */
function auditRotationSuffix(f: string): number {
  const m = f.match(/^audit-\d{4}-\d{2}-\d{2}-(\d+)\.jsonl$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Sort comparator (newest file first). Primary key = date (YYYY-MM-DD sorts
 * chronologically lexicographically; newer date first). Secondary key = rotation
 * suffix within the same day (higher = newer = first; base = 0 = oldest = last).
 * Fixes AUDIT-1: lexicographic sort put `audit-DATE-10` before `audit-DATE-2`.
 */
function compareAuditFilesNewestFirst(a: string, b: string): number {
  const dateA = a.slice('audit-'.length, 'audit-'.length + 10); // YYYY-MM-DD
  const dateB = b.slice('audit-'.length, 'audit-'.length + 10);
  if (dateA !== dateB) return dateB < dateA ? -1 : 1; // newer date first
  return auditRotationSuffix(b) - auditRotationSuffix(a); // higher suffix first
}

/**
 * Load the most recent `limit` audit entries from the audit directory.
 * Reads the current day's file (and yesterday's if needed to fill the limit).
 * Skips malformed lines gracefully.
 * Returns entries in chronological order (oldest first).
 */
export function loadRecentAuditEntries(
  workspaceDir: string,
  limit: number,
): PermissionAuditEntry[] {
  if (limit <= 0) return [];
  const dir = getAuditDir(workspaceDir);
  if (!fs.existsSync(dir)) return [];

  // Collect all audit JSONL files, sorted newest first.
  // AUDIT-1: a plain lexicographic `.sort().reverse()` mis-orders rotated files once
  // a day exceeds 9 rotations (`audit-DATE-10.jsonl` sorts before `audit-DATE-2.jsonl`)
  // and also puts the base file (oldest content that day) first. Sort by date descending,
  // then by numeric rotation suffix descending within the same day — the base file (no
  // suffix = 0) is the oldest, the highest suffix is the newest (actively-written) file.
  let files: string[];
  try {
    files = fs.readdirSync(dir)
      // M1: strict date pattern — a loose `audit-`/`.jsonl` filter let malformed
      // names (e.g. `audit-broken.jsonl`) sort among real dates via the date slice.
      .filter(f => AUDIT_FILE_RE.test(f))
      .sort((a, b) => compareAuditFilesNewestFirst(a, b));
  } catch {
    return [];
  }

  const allEntries: PermissionAuditEntry[] = [];

  for (const file of files) {
    if (allEntries.length >= limit) break;
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const fileEntries: PermissionAuditEntry[] = [];
      for (const line of lines) {
        try {
          fileEntries.push(JSON.parse(line) as PermissionAuditEntry);
        } catch {
          // Skip malformed lines
        }
      }
      // Prepend file entries (reading newest file first, so we prepend to keep chrono order)
      allEntries.unshift(...fileEntries);
    } catch {
      // Skip unreadable files
    }
  }

  // Return the last `limit` entries (most recent)
  return allEntries.slice(-limit);
}
