/**
 * Observation store: JSONL append + load + rotation + purge, with secret
 * scrubbing.
 *
 * Observations are scrubbed tool-call records written to
 * {workspaceDir}/.instinct/observations.jsonl (rotated at 10 MB, purged after
 * 30 days). They are the raw material for cross-session recall — NOT instincts
 * (promoted/evolved patterns are a later phase).
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const INSTINCT_SUBDIR = '.instinct';
const JSONL_EXT = '.jsonl';
/** Suffix of an in-progress purge rewrite (see purgeFile). */
const TMP_SUFFIX = '.tmp';
const OBSERVATIONS_FAMILY = 'observations';
const OBSERVATIONS_FILE = `${OBSERVATIONS_FAMILY}${JSONL_EXT}`;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB → rotate
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days → purge

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
  [/(api[_-]?key|token|secret|password|passwd|auth|bearer)["'\s:=]+[A-Za-z0-9_-]{16,}/gi, '$1=REDACTED'],
  // Inline -k / --header "Authorization: Bearer ..."
  [/(bearer|basic)\s+[A-Za-z0-9_.=]{16,}/gi, '$1 REDACTED'],
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
let _purgeFailures = 0;
export function getPurgeFailureCount(): number {
  return _purgeFailures;
}
export function _resetForTest(): void {
  _writeFailures = 0;
  _purgeFailures = 0;
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

// ── Retention purge ───────────────────────────────────────────────────────
/**
 * True when `file` belongs to `family`: exactly `<family>.jsonl`, or one of its
 * `<family>-N.jsonl` rotations. Deliberately not a prefix test — `observations`
 * must not scan a future `observations-summary.jsonl` family as its own.
 */
function isFamilyFile(file: string, family: string, ext = JSONL_EXT): boolean {
  if (!file.endsWith(ext)) return false;
  const stem = file.slice(0, -ext.length);
  if (stem === family) return true;
  return stem.startsWith(`${family}-`) && /^\d+$/.test(stem.slice(family.length + 1));
}

/** JSONL files of one family under .instinct/, unsorted. Throws if `dir` is unreadable. */
function listFamilyFiles(dir: string, family: string): string[] {
  return fs.readdirSync(dir).filter((f) => isFamilyFile(f, family));
}

/** Non-empty lines of a JSONL file. Throws if the file is unreadable. */
function readJsonlLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
}

/**
 * Rewrite one JSONL file without its expired entries, deleting the file when
 * nothing survives. Throws on I/O failure — purgeExpired counts it per file.
 */
function purgeFile(filePath: string, cutoff: number): void {
  const lines = readJsonlLines(filePath);
  const kept = lines.filter((line) => {
    // Drop what cannot be aged. An unparseable line is a partial write, which
    // loadRecentObservations already skips; a line with valid JSON but no
    // numeric `ts` IS recallable today, so dropping it deletes recallable data
    // on purpose — a record whose age cannot be established can never satisfy
    // the 30-day bound, and appendObservation always stamps `ts`, so such a
    // line is a half-written record or foreign content. Bounded retention wins
    // over recalling an unaged entry.
    let ts: unknown;
    try {
      ts = (JSON.parse(line) as Observation).ts;
    } catch {
      return false;
    }
    return typeof ts === 'number' && ts >= cutoff;
  });
  // Empty-check first: a file that was already empty has nothing expired to
  // rewrite, but must still not be left behind.
  if (kept.length === 0) {
    fs.unlinkSync(filePath);
    return;
  }
  if (kept.length === lines.length) return; // nothing expired — leave the file alone
  // Temp + rename: a crash mid-rewrite must not truncate surviving entries.
  const tmpPath = filePath + TMP_SUFFIX;
  fs.writeFileSync(tmpPath, kept.join('\n') + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Drop entries older than 30 days from one JSONL file family under .instinct/,
 * deleting files — and the directory — left empty, plus any `.jsonl.tmp` left
 * behind by a rewrite that crashed before its rename.
 *
 * `family` is a parameter because ticket-09 adds a second family
 * (instincts.jsonl) that has to reuse this path rather than grow a second
 * purge; `now` is injectable so tests get a deterministic clock.
 *
 * Never throws (same contract as appendObservation): a failed purge must not
 * break the hook that triggered it. Failures are counted for diagnostics.
 */
export function purgeExpired(
  workspaceDir: string,
  opts: { family?: string; now?: number } = {},
): void {
  const family = opts.family ?? OBSERVATIONS_FAMILY;
  const cutoff = (opts.now ?? Date.now()) - MAX_AGE_MS;
  const dir = path.join(workspaceDir, INSTINCT_SUBDIR);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // no .instinct/ yet (or unreadable) — nothing to purge
  }

  for (const f of entries) {
    // A leftover <family>.jsonl.tmp is a rewrite that died before its rename:
    // its content is a subset of the file it never replaced, so it is dropped
    // rather than purged. Leaving it would also pin .instinct/ open forever —
    // it is not a data file, so it never purges down to empty.
    const isStaleTmp = isFamilyFile(f, family, JSONL_EXT + TMP_SUFFIX);
    if (!isStaleTmp && !isFamilyFile(f, family)) continue;
    const filePath = path.join(dir, f);
    try {
      if (isStaleTmp) fs.unlinkSync(filePath);
      else purgeFile(filePath, cutoff);
    } catch (e) {
      _purgeFailures++;
      try { console.error(`[instinct] purge failed (${family}):`, e); } catch { /* noop */ }
    }
  }

  // Drop the directory once its last file is gone — no empty .instinct/ left.
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* still populated or unreadable — nothing to clean up */
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
  let files: string[];
  try {
    files = listFamilyFiles(dir, OBSERVATIONS_FAMILY);
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
      const lines = readJsonlLines(path.join(dir, f));
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
