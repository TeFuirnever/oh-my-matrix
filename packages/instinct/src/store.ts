/**
 * Instinct store: two JSONL file families under .instinct/, with secret
 * scrubbing, size-based rotation, and 30-day retention purge.
 *
 *  - observations.jsonl — scrubbed tool-call records (the raw material).
 *  - instincts.jsonl    — distilled working patterns, deduped by exact text
 *    with hit counts (the recall-confidence signal).
 *
 * Both families share one file-family substrate (membership test, recency
 * order, atomic rewrite, rolled append) — an invariant fix in one family
 * applies to both or neither.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const INSTINCT_SUBDIR = '.instinct';
const JSONL_EXT = '.jsonl';
/** Suffix of an in-progress atomic rewrite (see rewriteFileAtomic). */
const TMP_SUFFIX = '.tmp';
/** A rewrite tmp older than this is assumed dead (crashed before rename). */
const TMP_STALE_MS = 60_000;
const OBSERVATIONS_FAMILY = 'observations';
export const INSTINCTS_FAMILY = 'instincts';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB → rotate
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days → purge
/**
 * Raw instinct text is capped BEFORE scrubbing: the secret patterns include a
 * lazy `[\s\S]*?` scan that goes quadratic on megabyte input without an END
 * marker, and the tool schema's maxLength is not a guarantee for non-tool
 * callers of this exported API.
 */
const MAX_RAW_TEXT_CHARS = 5_000;

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

// ── File family ───────────────────────────────────────────────────────────
// A "family" is one logical JSONL log: the base `<family>.jsonl` plus its
// `<family>-N.jsonl` rotations. Append, purge and recall all agree on the same
// membership test and the same recency order through these helpers.

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

/** Filename of a family member by rotation number; 0 is the base file. */
function familyFileName(family: string, key: number): string {
  return key === 0 ? `${family}${JSONL_EXT}` : `${family}-${key}${JSONL_EXT}`;
}

/**
 * Sort key for a file of `family` where LARGER = NEWER. The base
 * `<family>.jsonl` is the OLDEST (key 0): writes roll into `<family>-N.jsonl`
 * only after the base fills, so `-N` is newer than the base and `-2` newer than
 * `-1`. The suffix is parsed numerically, not lexically, so `-10` ranks above
 * `-2` — the trap `auditFileRecencyKey` already documents in permission-policy.
 *
 * Only the canonical name for a key earns that key; anything else ranks below
 * every member (-1), so it sorts oldest and never displaces a real rotation.
 * `observations-0.jsonl` and `observations-007.jsonl` are the cases that matter:
 * this code never writes either, but an operator or a restore can leave one,
 * and a naive parse would hand them key 0 and key 7 — colliding with the base
 * file and with `observations-7.jsonl`, re-inverting recall. Exported for tests.
 */
export function familyFileRecencyKey(file: string, family: string): number {
  if (!isFamilyFile(file, family)) return -1;
  if (file === familyFileName(family, 0)) return 0;
  const key = Number(file.slice(family.length + 1, -JSONL_EXT.length));
  // Round-trip: the name must be the one familyFileName would produce.
  return familyFileName(family, key) === file ? key : -1;
}

/** JSONL files of one family under .instinct/, unsorted. Throws if `dir` is unreadable. */
function listFamilyFiles(dir: string, family: string): string[] {
  return fs.readdirSync(dir).filter((f) => isFamilyFile(f, family));
}

/**
 * Family files newest-first — the single home of the #177 recency order.
 * Every reader (recall, dedup scan) goes through here so the invariant lives
 * in one place beside its documentation in familyFileRecencyKey.
 */
function listFamilyFilesNewestFirst(dir: string, family: string): string[] {
  return listFamilyFiles(dir, family).sort(
    (a, b) => familyFileRecencyKey(b, family) - familyFileRecencyKey(a, family),
  );
}

/** Non-empty lines of a JSONL file. Throws if the file is unreadable. */
function readJsonlLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
}

let _tmpCounter = 0;
/**
 * Crash-safe full rewrite: write a sibling temp file, rename over the target.
 * The tmp name embeds pid + a per-process sequence so two plugin processes on
 * one workspace never share a tmp path, and a concurrent purge's stale-tmp
 * sweep (which age-gates) cannot mistake a live rewrite's tmp for a dead one.
 * Same idea as autopilot's atomicWriteFileSync.
 */
function rewriteFileAtomic(filePath: string, lines: string[]): void {
  const tmpPath = `${filePath}.${process.pid}.${++_tmpCounter}${TMP_SUFFIX}`;
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ── Store path + rotation ─────────────────────────────────────────────────
/**
 * Write target for the next append: the newest file of the family, rolling to
 * the next rotation number once it fills.
 *
 * Probing upward from the base file instead would send writes back to
 * `<family>.jsonl` whenever a purge left it below `MAX_FILE_BYTES` — by
 * deleting it (every entry expired) or merely by rewriting it smaller — while
 * newer rotations survived. The newest entries would then sit in the file recall
 * treats as oldest, breaking the invariant recall depends on (#177).
 *
 * Writability is deliberately NOT probed here: access(2) diverges from the
 * actual write under root/DAC overrides and would add a syscall to the
 * after_tool_call hot path. The appenders roll on the write's own failure
 * instead (appendLineWithRoll).
 */
function familyWriteTarget(
  dir: string,
  family: string,
  files?: string[],
): { path: string; key: number } {
  let listed: string[] = [];
  try {
    listed = files ?? listFamilyFiles(dir, family);
  } catch {
    /* .instinct/ does not exist yet — the appenders create it */
  }
  // Non-canonical names (key -1) are read last but never written to.
  const keys = listed.map((f) => familyFileRecencyKey(f, family)).filter((k) => k >= 0);
  if (keys.length === 0) return { path: path.join(dir, familyFileName(family, 0)), key: 0 };

  const newestKey = Math.max(...keys);
  const newest = path.join(dir, familyFileName(family, newestKey));
  try {
    if (fs.statSync(newest).size < MAX_FILE_BYTES) return { path: newest, key: newestKey };
  } catch {
    return { path: newest, key: newestKey }; // unreadable — let the append surface the failure
  }
  return { path: path.join(dir, familyFileName(family, newestKey + 1)), key: newestKey + 1 };
}

/**
 * Append one line to a family, rolling to the next rotation when — and only
 * when — the platform refuses the write with a permission/readonly error.
 * Throws on other failures; callers keep their never-throw contracts.
 */
function appendLineWithRoll(dir: string, family: string, line: string, files?: string[]): void {
  const target = familyWriteTarget(dir, family, files);
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  try {
    fs.appendFileSync(target.path, line, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw e;
    // Rolled write: the new rotation ranks above the unwritable newest either
    // way, so the recency invariant holds.
    const rolled = path.join(dir, familyFileName(family, target.key + 1));
    fs.mkdirSync(path.dirname(rolled), { recursive: true });
    fs.appendFileSync(rolled, line, 'utf-8');
  }
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
    appendLineWithRoll(path.join(workspaceDir, INSTINCT_SUBDIR), OBSERVATIONS_FAMILY, JSON.stringify(clean) + '\n');
  } catch (e) {
    _writeFailures++;
    try { console.error('[instinct] observation append failed:', e); } catch { /* noop */ }
  }
}

// ── Retention purge ───────────────────────────────────────────────────────
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
  rewriteFileAtomic(filePath, kept); // a crash mid-rewrite must not truncate survivors
}

/**
 * Strip the `.<pid>.<seq>` infix rewriteFileAtomic adds, yielding the data file
 * a tmp belongs to. Null when the name is not one of its family's tmps.
 */
function tmpOwnerFamilyFile(file: string, family: string): string | null {
  if (!file.endsWith(TMP_SUFFIX)) return null;
  const stem = file.slice(0, -TMP_SUFFIX.length).replace(/\.\d+\.\d+$/, '');
  return isFamilyFile(stem, family) ? stem : null;
}

/**
 * Drop entries older than 30 days from one JSONL file family under .instinct/,
 * deleting files — and the directory — left empty, plus rewrite tmps left
 * behind by a rewrite that crashed before its rename.
 *
 * A tmp is only swept when older than TMP_STALE_MS: a live concurrent
 * rewrite's tmp exists for microseconds, while a dead one is at least a
 * crashed-process lifetime old. Its content is a subset of the file it never
 * replaced, so it is dropped rather than purged; leaving it would pin
 * .instinct/ open forever — it is not a data file, so it never purges to empty.
 *
 * `family` is a parameter so both families share this path; `now` is injectable
 * so tests get a deterministic clock.
 *
 * Never throws (same contract as appendObservation): a failed purge must not
 * break the hook that triggered it. Failures are counted for diagnostics.
 *
 * Known limitation: no cross-process serialization. Two plugin processes on
 * one workspace can interleave read-modify-write cycles on the same file; the
 * unique tmp names prevent tmp clobbering, but a lost update (one process's
 * line silently overwritten by another's rename) is still possible. Locking
 * is deliberately out of scope at this store's scale — see the ticket tracker.
 */
export function purgeExpired(
  workspaceDir: string,
  opts: { family?: string; now?: number } = {},
): void {
  const family = opts.family ?? OBSERVATIONS_FAMILY;
  const now = opts.now ?? Date.now();
  const cutoff = now - MAX_AGE_MS;
  const dir = path.join(workspaceDir, INSTINCT_SUBDIR);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // no .instinct/ yet (or unreadable) — nothing to purge
  }

  for (const f of entries) {
    const tmpOwner = tmpOwnerFamilyFile(f, family);
    if (!tmpOwner && !isFamilyFile(f, family)) continue;
    const filePath = path.join(dir, f);
    try {
      if (tmpOwner) {
        // Age-gated: only a dead rewrite's tmp is swept (see above).
        if (fs.statSync(filePath).mtimeMs < now - TMP_STALE_MS) fs.unlinkSync(filePath);
      } else {
        purgeFile(filePath, cutoff);
      }
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
    files = listFamilyFilesNewestFirst(dir, OBSERVATIONS_FAMILY);
  } catch {
    return [];
  }

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

// ── Instincts (distilled patterns, ticket-09) ─────────────────────────────
export interface Instinct {
  ts: number;
  /** The pattern itself (scrubbed, truncated). */
  text: string;
  /**
   * 'project' = recalled only for the recording project; 'global' = recalled
   * from any session reading this same project's store (cross-project sharing
   * arrives with promote/evolve — the scope is stamped now because it is the
   * one field later phases cannot reconstruct).
   */
  scope: 'project' | 'global';
  /** Recording project id — provenance, stamped even on global instincts. */
  project?: string;
  /** Times this exact text was recorded — the observable confidence signal. */
  hits: number;
  /**
   * sha256 of the whitespace-normalized RAW text [:16] — the dedup identity.
   * Matching on the stored (truncated) text alone would merge two distinct
   * long instincts that share a 497-char prefix, silently dropping the second.
   */
  hash?: string;
}

/** What appendInstinct actually did — the caller-facing truth, not a request echo. */
export type InstinctAppendOutcome =
  | { status: 'empty' }
  | { status: 'failed' }
  | { status: 'hit'; scope: Instinct['scope']; hits: number }
  | { status: 'written'; scope: Instinct['scope'] };

/** Dedup identity of a raw text — survives scrub, truncation and reflowing. Exported for tests. */
export function instinctHash(raw: string): string {
  return createHash('sha256').update(raw.replace(/\s+/g, ' ')).digest('hex').substring(0, 16);
}

/** A stored record and an incoming entry describe the same instinct slot. */
function sameInstinctSlot(
  rec: Instinct,
  text: string,
  hash: string,
  scope: Instinct['scope'],
  projId: string,
): boolean {
  if (rec.text !== text || rec.hash !== hash) return false;
  // Scope-class match: global↔global, or project↔project from the SAME
  // project. A cross-project or cross-scope re-record is a different slot —
  // text-only matching would swallow project B's record into project A's
  // (never recalled in B) or promote/demote silently against the tool's echo.
  if (rec.scope === 'global') return scope === 'global';
  return scope === 'project' && rec.project === projId;
}

/**
 * Scan the instincts family newest-first for the record occupying this entry's
 * slot. Null when none does. An unreadable file is skipped, not fatal: a match
 * inside it is invisible (a duplicate line becomes possible) — preferred over
 * losing the record entirely, which blocking the append would do.
 */
function findInstinctSlot(
  dir: string,
  text: string,
  hash: string,
  scope: Instinct['scope'],
  projId: string,
): { filePath: string; lines: string[]; idx: number; rec: Instinct } | null {
  let files: string[];
  try {
    files = listFamilyFilesNewestFirst(dir, INSTINCTS_FAMILY);
  } catch {
    return null; // no .instinct/ yet
  }
  for (const f of files) {
    const filePath = path.join(dir, f);
    let lines: string[];
    try {
      lines = readJsonlLines(filePath);
    } catch {
      continue; // unreadable — skip, see above
    }
    const idx = lines.findIndex((line) => {
      try {
        return sameInstinctSlot(JSON.parse(line) as Instinct, text, hash, scope, projId);
      } catch {
        return false; // leave malformed lines alone
      }
    });
    if (idx !== -1) return { filePath, lines, idx, rec: JSON.parse(lines[idx]) as Instinct };
  }
  return null;
}

/**
 * Upsert one instinct into the instincts family. Dedup matches the stored
 * text AND the raw-text hash within the same scope class: a hit updates `ts`
 * (floored against clock skew) and increments `hits` in place rather than
 * appending a duplicate line — repeated patterns must not crowd the recall
 * section, and `hits` is the confidence proxy (ticket-09 design decision 4).
 * The first recording's scope stands; promotion is a later-phase feature.
 *
 * Returns the outcome so callers (the tool) report what took effect, not what
 * was requested. `now` is injectable so tests get a deterministic clock.
 * Never throws, matching appendObservation's contract; the failure counter
 * stays for aggregate diagnostics.
 */
export function appendInstinct(
  workspaceDir: string,
  entry: { text: string; scope: Instinct['scope'] },
  now: number = Date.now(),
): InstinctAppendOutcome {
  // Cap BEFORE scrubbing — see MAX_RAW_TEXT_CHARS.
  const raw = String(entry.text ?? '').slice(0, MAX_RAW_TEXT_CHARS);
  const text = truncate(raw);
  if (text == null || text.trim().length === 0) return { status: 'empty' };
  const dir = path.join(workspaceDir, INSTINCT_SUBDIR);
  try {
    const slot = findInstinctSlot(dir, text, instinctHash(raw), entry.scope, projectId(workspaceDir));
    if (slot) {
      // Floor against clock skew: a hit must never regress ts — ts feeds
      // ranking and the 30-day purge countdown.
      slot.rec.ts = Math.max(typeof slot.rec.ts === 'number' ? slot.rec.ts : 0, now);
      slot.rec.hits = (typeof slot.rec.hits === 'number' ? slot.rec.hits : 0) + 1;
      slot.lines[slot.idx] = JSON.stringify(slot.rec);
      rewriteFileAtomic(slot.filePath, slot.lines);
      return { status: 'hit', scope: slot.rec.scope, hits: slot.rec.hits };
    }
    const rec: Instinct = {
      ts: now,
      text,
      scope: entry.scope,
      project: projectId(workspaceDir),
      hits: 1,
      hash: instinctHash(raw),
    };
    appendLineWithRoll(dir, INSTINCTS_FAMILY, JSON.stringify(rec) + '\n');
    return { status: 'written', scope: rec.scope };
  } catch (e) {
    _writeFailures++;
    try { console.error('[instinct] instinct append failed:', e); } catch { /* noop */ }
    return { status: 'failed' };
  }
}

/**
 * Load instincts for recall: global ones plus this project's own, ranked by
 * `hits` desc (confidence) then `ts` desc, newest-first within equal hits.
 * `project == null` returns everything (global and project-scoped alike),
 * mirroring loadRecentObservations.
 */
export function loadInstincts(workspaceDir: string, limit: number, project?: string): Instinct[] {
  if (limit <= 0) return [];
  const dir = path.join(workspaceDir, INSTINCT_SUBDIR);
  let files: string[];
  try {
    files = listFamilyFilesNewestFirst(dir, INSTINCTS_FAMILY);
  } catch {
    return [];
  }

  const out: Instinct[] = [];
  for (const f of files) {
    try {
      for (const line of readJsonlLines(path.join(dir, f))) {
        try {
          const rec = JSON.parse(line) as Instinct;
          if (typeof rec.text !== 'string' || rec.text.length === 0) continue;
          if (project != null && rec.scope === 'project' && rec.project !== project) continue;
          out.push(rec);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* skip unreadable file */
    }
  }
  out.sort((a, b) => b.hits - a.hits || b.ts - a.ts);
  return out.slice(0, limit);
}
