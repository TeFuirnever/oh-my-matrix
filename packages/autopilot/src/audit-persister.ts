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

  // Collect all audit JSONL files, sorted newest first
  let files: string[];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest date first
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
