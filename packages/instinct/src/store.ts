/**
 * Observation store: JSONL append + load + rotation, with secret scrubbing.
 *
 * Observations are scrubbed tool-call records written to
 * {workspaceDir}/.instinct/observations.jsonl (rotated at 10 MB). They are the
 * raw material for cross-session recall — NOT instincts (promoted/evolved
 * patterns are a later phase).
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const INSTINCT_SUBDIR = '.instinct';
const OBSERVATIONS_FILE = 'observations.jsonl';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB → rotate

export interface Observation {
  ts: number;
  tool: string;
  /** Short input summary (scrubbed, truncated). */
  input?: string;
  /** Short output summary (scrubbed, truncated). */
  output?: string;
  /** Project id = sha256(git remote url)[:12], for scoping recall. */
  project?: string;
}

// ── Secret scrubbing ──────────────────────────────────────────────────────
// Redact common secret shapes BEFORE writing to disk. Conservative — errs on
// over-redaction (a false redaction is cheap; a leaked secret is not).
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // API keys / tokens (long hex/base64 after a key name)
  [/(api[_-]?key|token|secret|password|passwd|auth|bearer)["'\s:=]+[A-Za-z0-9_\-]{16,}/gi, '$1=REDACTED'],
  // Inline -k / --header "Authorization: Bearer ..."
  [/(bearer|basic)\s+[A-Za-z0-9_\-\.=]{16,}/gi, '$1 REDACTED'],
  // Private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'REDACTED_PRIVATE_KEY'],
  // AWS keys
  [/AKIA[0-9A-Z]{16}/g, 'REDACTED_AWS_KEY'],
];

/** Redact secret-like substrings. Exported for unit tests. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, repl as string);
  }
  return out;
}

const MAX_FIELD_CHARS = 500;

function truncate(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const t = scrubSecrets(String(text));
  return t.length > MAX_FIELD_CHARS ? t.substring(0, MAX_FIELD_CHARS - 3) + '...' : t;
}

// ── Project id ────────────────────────────────────────────────────────────
/**
 * Stable project id = sha256(git remote origin url)[:12]. Falls back to
 * 'unknown' when git is unavailable (no .git / detached). Exported for tests.
 */
export function projectId(workspaceDir: string): string {
  try {
    const config = fs.readFileSync(path.join(workspaceDir, '.git', 'config'), 'utf-8');
    const m = config.match(/^\s*url\s*=\s*(.+)$/m);
    if (!m) return 'unknown';
    return createHash('sha256').update(m[1].trim()).digest('hex').substring(0, 12);
  } catch {
    return 'unknown';
  }
}

// ── Store path + rotation ─────────────────────────────────────────────────
function observationsPath(workspaceDir: string): string {
  const dir = path.join(workspaceDir, INSTINCT_SUBDIR);
  let candidate = path.join(dir, OBSERVATIONS_FILE);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    try {
      if (fs.statSync(candidate).size < MAX_FILE_BYTES) break;
    } catch {
      break;
    }
    candidate = path.join(dir, `observations-${suffix}.jsonl`);
    suffix++;
  }
  return candidate;
}

let _writeFailures = 0;
export function getWriteFailureCount(): number {
  return _writeFailures;
}
export function _resetForTest(): void {
  _writeFailures = 0;
}

/** Append one scrubbed observation. Never throws. */
export function appendObservation(obs: Observation, workspaceDir: string): void {
  const clean: Observation = {
    ts: obs.ts,
    tool: obs.tool,
    input: truncate(obs.input),
    output: truncate(obs.output),
    project: obs.project,
  };
  try {
    const filePath = observationsPath(workspaceDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(clean) + '\n', 'utf-8');
  } catch (e) {
    _writeFailures++;
    try { console.error('[instinct] observation append failed:', e); } catch { /* noop */ }
  }
}

/**
 * Load the most recent `limit` observations for the given project (or all
 * projects when undefined). Reads from the newest rotation file backward.
 */
export function loadRecentObservations(
  workspaceDir: string,
  limit: number,
  project?: string,
): Observation[] {
  const dir = path.join(workspaceDir, INSTINCT_SUBDIR);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('observations') && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  // Newest rotation first: observations.jsonl is the live (newest) file,
  // observations-N.jsonl are older as N grows.
  files.sort((a, b) => {
    if (a === OBSERVATIONS_FILE) return -1;
    if (b === OBSERVATIONS_FILE) return 1;
    const na = Number(a.match(/-(\d+)\./)?.[1] ?? 0);
    const nb = Number(b.match(/-(\d+)\./)?.[1] ?? 0);
    return na - nb;
  });

  const out: Observation[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    try {
      const lines = fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (out.length >= limit) break;
        try {
          const obs = JSON.parse(lines[i]) as Observation;
          if (project == null || obs.project === project) out.push(obs);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* skip unreadable file */
    }
  }
  return out.slice(0, limit);
}
