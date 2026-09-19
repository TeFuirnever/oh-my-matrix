/**
 * instinct store: 30-day time-based purge (retention), incl. failure paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  purgeExpired,
  getPurgeFailureCount,
  loadRecentObservations,
  _resetForTest,
} from '../src/store';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 18); // fixed clock — purge is age-relative, not wall-clock

let dir: string;
let instinctDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instinct-purge-'));
  instinctDir = join(dir, '.instinct');
  _resetForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write raw JSONL lines into .instinct/<name> (bypasses append for age control). */
function writeJsonl(name: string, entries: unknown[]): void {
  mkdirSync(instinctDir, { recursive: true });
  writeFileSync(join(instinctDir, name), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function readLines(name: string): string[] {
  return readFileSync(join(instinctDir, name), 'utf-8').split('\n').filter(Boolean);
}

describe('purgeExpired', () => {
  it('drops entries older than 30 days and keeps the rest', () => {
    writeJsonl('observations.jsonl', [
      { ts: NOW - 31 * DAY, tool: 'Old', project: 'p' },
      { ts: NOW - 29 * DAY, tool: 'Fresh', project: 'p' },
      { ts: NOW, tool: 'Now', project: 'p' },
    ]);

    purgeExpired(dir, { now: NOW });

    const kept = loadRecentObservations(dir, 10, 'p');
    expect(kept.map((o) => o.tool)).toEqual(['Now', 'Fresh']); // newest first
    expect(getPurgeFailureCount()).toBe(0);
  });

  it('purges rotation files of the same family', () => {
    writeJsonl('observations.jsonl', [{ ts: NOW, tool: 'Live', project: 'p' }]);
    writeJsonl('observations-1.jsonl', [
      { ts: NOW - 40 * DAY, tool: 'Stale', project: 'p' },
      { ts: NOW - 10 * DAY, tool: 'Recent', project: 'p' },
    ]);

    purgeExpired(dir, { now: NOW });

    expect(readLines('observations.jsonl')).toHaveLength(1);
    expect(readLines('observations-1.jsonl')).toHaveLength(1);
    // Order-insensitive: cross-file recency ordering is the loader's business, not purge's.
    expect(loadRecentObservations(dir, 10, 'p').map((o) => o.tool).sort()).toEqual(['Live', 'Recent']);
  });

  it('leaves no empty file or empty .instinct dir when everything expired', () => {
    writeJsonl('observations.jsonl', [{ ts: NOW - 31 * DAY, tool: 'Old' }]);
    writeJsonl('observations-1.jsonl', [{ ts: NOW - 99 * DAY, tool: 'Older' }]);

    purgeExpired(dir, { now: NOW });

    expect(existsSync(join(instinctDir, 'observations.jsonl'))).toBe(false);
    expect(existsSync(join(instinctDir, 'observations-1.jsonl'))).toBe(false);
    expect(existsSync(instinctDir)).toBe(false); // no empty dir left behind
    expect(loadRecentObservations(dir, 10)).toEqual([]);
  });

  it('keeps the dir when another file family still holds entries', () => {
    writeJsonl('observations.jsonl', [{ ts: NOW - 31 * DAY, tool: 'Old' }]);
    writeJsonl('instincts.jsonl', [{ ts: NOW, tool: 'Kept' }]);

    purgeExpired(dir, { now: NOW });

    expect(existsSync(join(instinctDir, 'observations.jsonl'))).toBe(false);
    expect(existsSync(instinctDir)).toBe(true);
    expect(readLines('instincts.jsonl')).toHaveLength(1); // other family untouched
  });

  it('purges a caller-specified file family', () => {
    writeJsonl('instincts.jsonl', [
      { ts: NOW - 31 * DAY, tool: 'Old' },
      { ts: NOW, tool: 'Kept' },
    ]);

    purgeExpired(dir, { family: 'instincts', now: NOW });

    expect(readLines('instincts.jsonl')).toHaveLength(1);
  });

  it('drops lines whose age cannot be determined', () => {
    mkdirSync(instinctDir, { recursive: true });
    writeFileSync(
      join(instinctDir, 'observations.jsonl'),
      ['{not json', JSON.stringify({ tool: 'NoTs' }), JSON.stringify({ ts: NOW, tool: 'Kept' })].join('\n') + '\n',
      'utf-8',
    );
    // A ts-less line IS recallable before the purge — dropping it trades that
    // recall for a retention bound the entry could otherwise never satisfy.
    expect(loadRecentObservations(dir, 10).map((o) => o.tool)).toEqual(['Kept', 'NoTs']);

    purgeExpired(dir, { now: NOW });

    expect(readLines('observations.jsonl')).toHaveLength(1);
    expect(loadRecentObservations(dir, 10).map((o) => o.tool)).toEqual(['Kept']);
  });

  it('deletes a file that was already empty', () => {
    mkdirSync(instinctDir, { recursive: true });
    writeFileSync(join(instinctDir, 'observations.jsonl'), '', 'utf-8');

    purgeExpired(dir, { now: NOW });

    expect(existsSync(instinctDir)).toBe(false); // no empty file, no empty dir
    expect(getPurgeFailureCount()).toBe(0);
  });

  it('clears a dead rewrite tmp (unique name, past the staleness age)', () => {
    writeJsonl('observations.jsonl', [{ ts: NOW - 31 * DAY, tool: 'Old' }]);
    // rewriteFileAtomic's form: <file>.<pid>.<seq>.tmp, mtime old enough to be dead.
    const tmp = join(instinctDir, 'observations.jsonl.99999.1.tmp');
    writeFileSync(tmp, JSON.stringify({ ts: NOW, tool: 'Half' }) + '\n', 'utf-8');
    const stale = (NOW - 120_000) / 1000; // older than TMP_STALE_MS (60 s)
    utimesSync(tmp, stale, stale);

    purgeExpired(dir, { now: NOW });

    // The temp file is not a data file: left in place it would pin .instinct/ open forever.
    expect(existsSync(instinctDir)).toBe(false);
    expect(getPurgeFailureCount()).toBe(0);
  });

  it('keeps a LIVE rewrite tmp (inside the staleness window)', () => {
    writeJsonl('observations.jsonl', [{ ts: NOW - 31 * DAY, tool: 'Old' }]);
    const tmp = join(instinctDir, 'observations.jsonl.99999.1.tmp');
    writeFileSync(tmp, JSON.stringify({ ts: NOW, tool: 'InFlight' }) + '\n', 'utf-8');
    // mtime is NOW (just written) — a concurrent process's in-flight rewrite.

    purgeExpired(dir, { now: NOW });

    // A live writer's tmp must survive the sweep; only the data file purged away.
    expect(existsSync(tmp)).toBe(true);
    expect(existsSync(join(instinctDir, 'observations.jsonl'))).toBe(false);
    expect(getPurgeFailureCount()).toBe(0);
  });

  it('leaves a different family that merely shares the name prefix', () => {
    writeJsonl('observations.jsonl', [{ ts: NOW - 31 * DAY, tool: 'Old' }]);
    writeJsonl('observations-summary.jsonl', [{ ts: NOW - 99 * DAY, tool: 'NotMine' }]);

    purgeExpired(dir, { now: NOW });

    expect(existsSync(join(instinctDir, 'observations.jsonl'))).toBe(false);
    expect(readLines('observations-summary.jsonl')).toHaveLength(1); // not an `observations` rotation
  });

  it('rewrites nothing when no entry has expired', () => {
    const fresh = [{ ts: NOW - DAY, tool: 'A' }, { ts: NOW, tool: 'B' }];
    writeJsonl('observations.jsonl', fresh);
    const before = readFileSync(join(instinctDir, 'observations.jsonl'), 'utf-8');

    purgeExpired(dir, { now: NOW });

    expect(readFileSync(join(instinctDir, 'observations.jsonl'), 'utf-8')).toBe(before);
    expect(readdirSync(instinctDir)).toEqual(['observations.jsonl']); // no leftover temp file
    expect(getPurgeFailureCount()).toBe(0);
  });

  it('is a no-op when .instinct does not exist', () => {
    expect(() => purgeExpired(dir, { now: NOW })).not.toThrow();
    expect(existsSync(instinctDir)).toBe(false);
    expect(getPurgeFailureCount()).toBe(0);
  });

  it('never throws when the .instinct path is unreadable', () => {
    writeFileSync(instinctDir, 'not a directory', 'utf-8'); // readdir → ENOTDIR

    expect(() => purgeExpired(dir, { now: NOW })).not.toThrow();
  });

  it('never throws when one file cannot be rewritten, and records the failure', () => {
    mkdirSync(join(instinctDir, 'observations.jsonl'), { recursive: true }); // read → EISDIR
    writeJsonl('observations-1.jsonl', [
      { ts: NOW - 31 * DAY, tool: 'Old' },
      { ts: NOW, tool: 'Kept' },
    ]);

    expect(() => purgeExpired(dir, { now: NOW })).not.toThrow();
    expect(getPurgeFailureCount()).toBe(1);
    expect(readLines('observations-1.jsonl')).toHaveLength(1); // other files still purged
  });
});
