"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports._todayStringForTest = _todayStringForTest;
exports.getAuditFilePath = getAuditFilePath;
exports.appendAuditEntry = appendAuditEntry;
exports.auditFileRecencyKey = auditFileRecencyKey;
exports.loadRecentAuditEntries = loadRecentAuditEntries;
/**
 * Audit log persistence for autopilot permission audit entries.
 *
 * Writes PermissionAuditEntry records to JSONL files under
 * {workspaceDir}/.autopilot/audit-{YYYY-MM-DD}.jsonl
 *
 * Design: synchronous file I/O (plugin runs in main process; simplicity > async here).
 * No external dependencies.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const AUDIT_SUBDIR = '.autopilot';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
/** Returns the audit directory path for a given workspace root. */
function getAuditDir(workspaceDir) {
    return path.join(workspaceDir, AUDIT_SUBDIR);
}
/**
 * Returns YYYY-MM-DD for the given date using LOCAL time (not UTC).
 * Exported for testing; production code uses the private todayString() wrapper.
 */
function _todayStringForTest(d) {
    return [
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
    ].join('-');
}
/** Returns today's YYYY-MM-DD string in local time. */
function todayString() {
    return _todayStringForTest(new Date());
}
/**
 * Returns the path for the current audit JSONL file.
 * If the current file exceeds MAX_FILE_BYTES, appends a numeric suffix.
 */
function getAuditFilePath(workspaceDir) {
    const dir = getAuditDir(workspaceDir);
    const base = `audit-${todayString()}`;
    // Find the right suffix: start at no suffix, increment if file is too big
    let candidate = path.join(dir, `${base}.jsonl`);
    let suffix = 1;
    while (fs.existsSync(candidate)) {
        try {
            const stat = fs.statSync(candidate);
            if (stat.size < MAX_FILE_BYTES)
                break;
        }
        catch {
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
function appendAuditEntry(entry, workspaceDir) {
    try {
        const filePath = getAuditFilePath(workspaceDir);
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    }
    catch (e) {
        // Audit persistence must never crash the plugin — but the JSONL trail is the
        // sole forensic record (in-memory trail is capped + lost on process exit), so
        // a silent write failure must at least be visible to operators. Nested guard
        // so the logger itself can never throw. (F2: was a bare `catch {}`.)
        try {
            console.error('[permission-policy] audit append failed:', e);
        }
        catch { /* noop */ }
    }
}
/**
 * Sort key for an audit filename where LARGER = NEWER. Base file `audit-DATE.jsonl`
 * sorts before its same-day rotations (`audit-DATE-1.jsonl`, `-2`, …) because writes
 * roll into `-N` only after the base fills, so `-N` is always newer than the base.
 * Numeric suffix parse (not lexical) so `-10` ranks above `-2`. Exported for tests.
 */
function auditFileRecencyKey(f) {
    const m = f.match(/^audit-(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?\.jsonl$/);
    if (!m)
        return -1;
    const [, y, mo, d, suf] = m;
    return Number(`${y}${mo}${d}`) * 1000 + (suf ? Number(suf) : 0);
}
/**
 * Load the most recent `limit` audit entries from the audit directory.
 * Reads the current day's file (and yesterday's if needed to fill the limit).
 * Skips malformed lines gracefully.
 * Returns entries in chronological order (oldest first).
 */
function loadRecentAuditEntries(workspaceDir, limit) {
    if (limit <= 0)
        return [];
    const dir = getAuditDir(workspaceDir);
    if (!fs.existsSync(dir))
        return [];
    // Collect all audit JSONL files, sorted newest first
    let files;
    try {
        files = fs.readdirSync(dir)
            .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
            // Newest file first. A bare `.sort().reverse()` is NOT correct once same-day
            // suffix rotation is in play: `audit-DATE-1.jsonl` is NEWER than the base
            // `audit-DATE.jsonl` (writes roll to `-1` after the base hits 10MB), but
            // `'-'(0x2D) < '.'(0x2E)` puts `-1` lexically BEFORE the base, so `.reverse()`
            // ordered the OLDER base first → `loadRecentAuditEntries` returned stale
            // entries and (via the early `break` below) never opened the rotated file.
            // Integer suffix is required: a lexical `-N` comparator re-breaks at `-10`
            // (sorts before `-2`), and mtime breaks under operator `touch`/restore.
            // (F1 fix.) auditFileRecencyKey: larger = newer.
            .sort((a, b) => auditFileRecencyKey(b) - auditFileRecencyKey(a));
    }
    catch {
        return [];
    }
    const allEntries = [];
    for (const file of files) {
        if (allEntries.length >= limit)
            break;
        const filePath = path.join(dir, file);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            const fileEntries = [];
            for (const line of lines) {
                try {
                    fileEntries.push(JSON.parse(line));
                }
                catch {
                    // Skip malformed lines
                }
            }
            // Prepend file entries (reading newest file first, so we prepend to keep chrono order)
            allEntries.unshift(...fileEntries);
        }
        catch {
            // Skip unreadable files
        }
    }
    // Return the last `limit` entries (most recent)
    return allEntries.slice(-limit);
}
//# sourceMappingURL=audit-persister.js.map