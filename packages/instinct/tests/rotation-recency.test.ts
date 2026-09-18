/**
 * instinct store: rotation recency — which file holds the newest observations.
 *
 * Writes roll into observations-N.jsonl only AFTER observations.jsonl fills
 * (see observationsPath), so `-N` is newer than the base file and `-2` is newer
 * than `-1`. Recall has to read in that order, or a rotated store silently
 * recalls its oldest entries forever (issue #177).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendObservation,
  loadRecentObservations,
  familyFileRecencyKey,
  _resetForTest,
} from '../src/store';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

let dir: string;
let instinctDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instinct-rotation-'));
  instinctDir = join(dir, '.instinct');
  mkdirSync(instinctDir, { recursive: true });
  _resetForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeJsonl(name: string, entries: unknown[]): void {
  writeFileSync(join(instinctDir, name), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

describe('familyFileRecencyKey', () => {
  it('ranks the base file oldest and higher rotation numbers newer', () => {
    const files = ['observations-2.jsonl', 'observations.jsonl', 'observations-1.jsonl'];
    const newestFirst = [...files].sort(
      (a, b) => familyFileRecencyKey(b, 'observations') - familyFileRecencyKey(a, 'observations'),
    );
    expect(newestFirst).toEqual(['observations-2.jsonl', 'observations-1.jsonl', 'observations.jsonl']);
  });

  it('parses the suffix numerically, so -10 outranks -2', () => {
    // A lexical comparator puts '-10' before '-2'; this is the trap the
    // permission-policy audit log already hit (auditFileRecencyKey, F1 fix).
    expect(familyFileRecencyKey('observations-10.jsonl', 'observations')).toBeGreaterThan(
      familyFileRecencyKey('observations-2.jsonl', 'observations'),
    );
  });

  it('ranks a name outside the family below every member', () => {
    expect(familyFileRecencyKey('observations-summary.jsonl', 'observations')).toBeLessThan(
      familyFileRecencyKey('observations.jsonl', 'observations'),
    );
  });

  it('refuses a non-canonical name that would collide with a real key', () => {
    // This code writes neither, but an operator or a restore can leave one. A
    // naive parse gives `-0` key 0 (the base file's) and `-007` key 7
    // (observations-7.jsonl's), putting two files at one key.
    expect(familyFileRecencyKey('observations-0.jsonl', 'observations')).toBe(-1);
    expect(familyFileRecencyKey('observations-007.jsonl', 'observations')).toBe(-1);
  });
});

describe('loadRecentObservations across rotations', () => {
  it('reads the newest rotation first', () => {
    writeJsonl('observations.jsonl', [{ ts: 1, tool: 'OLDEST', project: 'p' }]);
    writeJsonl('observations-1.jsonl', [{ ts: 2, tool: 'MIDDLE', project: 'p' }]);
    writeJsonl('observations-2.jsonl', [{ ts: 3, tool: 'NEWEST', project: 'p' }]);

    expect(loadRecentObservations(dir, 3, 'p').map((o) => o.tool)).toEqual([
      'NEWEST',
      'MIDDLE',
      'OLDEST',
    ]);
  });

  it('orders -10 above -2 through the loader, not just the key function', () => {
    // The documented trap is in the loader's sort: a lexical comparator puts
    // '-10' before '-2'. Asserting only on the key function would not catch a
    // second call site that re-sorts by name.
    writeJsonl('observations-2.jsonl', [{ ts: 2, tool: 'TWO', project: 'p' }]);
    writeJsonl('observations-10.jsonl', [{ ts: 10, tool: 'TEN', project: 'p' }]);

    expect(loadRecentObservations(dir, 2, 'p').map((o) => o.tool)).toEqual(['TEN', 'TWO']);
  });

  it('ignores mtime, so touching the base file does not make it newest', () => {
    writeJsonl('observations.jsonl', [{ ts: 1, tool: 'OLDEST', project: 'p' }]);
    writeJsonl('observations-1.jsonl', [{ ts: 2, tool: 'NEWEST', project: 'p' }]);
    // An operator `touch`, a backup restore, or a checkout reorders mtimes;
    // recency comes from the filename, so it must survive that.
    const future = Date.now() / 1000 + 3600;
    utimesSync(join(instinctDir, 'observations.jsonl'), future, future);

    expect(loadRecentObservations(dir, 1, 'p')[0]?.tool).toBe('NEWEST');
  });

  it('reads a non-canonical leftover last', () => {
    writeJsonl('observations-0.jsonl', [{ ts: 1, tool: 'LEFTOVER', project: 'p' }]);
    writeJsonl('observations.jsonl', [{ ts: 2, tool: 'REAL', project: 'p' }]);

    expect(loadRecentObservations(dir, 2, 'p').map((o) => o.tool)).toEqual(['REAL', 'LEFTOVER']);
  });

  it('recalls the newest observation once the base file has rotated', () => {
    // The real trigger: the base file is only left behind after it fills, and
    // `limit` is satisfied from the first file read — so a wrong order does not
    // merely reorder results, it never opens the rotated file at all.
    const filler = JSON.stringify({ ts: 1, tool: 'OLD', input: 'x'.repeat(40), project: 'p' }) + '\n';
    writeFileSync(
      join(instinctDir, 'observations.jsonl'),
      filler.repeat(Math.ceil(MAX_FILE_BYTES / filler.length) + 10),
      'utf-8',
    );
    expect(statSync(join(instinctDir, 'observations.jsonl')).size).toBeGreaterThan(MAX_FILE_BYTES);

    appendObservation({ ts: 2_000_000, tool: 'NEW', input: 'newest', project: 'p' }, dir);
    expect(readdirSync(instinctDir)).toContain('observations-1.jsonl'); // rotation happened

    expect(loadRecentObservations(dir, 1, 'p')[0]?.tool).toBe('NEW');
  });

  it('keeps the base file oldest after a purge deleted it', () => {
    // purgeExpired can delete `observations.jsonl` (all entries expired) while a
    // newer rotation survives. Appending must continue into the surviving newest
    // file, not re-create the base file — a base file holding the newest entries
    // would invert the recency order recall relies on.
    writeJsonl('observations-1.jsonl', [{ ts: 2, tool: 'SURVIVOR', project: 'p' }]);

    appendObservation({ ts: 3, tool: 'AFTER_PURGE', project: 'p' }, dir);

    expect(readdirSync(instinctDir)).toEqual(['observations-1.jsonl']); // no base file re-created
    expect(loadRecentObservations(dir, 2, 'p').map((o) => o.tool)).toEqual([
      'AFTER_PURGE',
      'SURVIVOR',
    ]);
  });

  it('keeps the base file oldest after a purge merely shrank it', () => {
    // The weaker trigger, and the easier one to hit: purge does not have to
    // DELETE the base file. Rewriting it below MAX_FILE_BYTES is enough for a
    // base-file-first probe to resume writing there.
    writeJsonl('observations.jsonl', [{ ts: 1, tool: 'SHRUNK', project: 'p' }]);
    writeJsonl('observations-1.jsonl', [{ ts: 2, tool: 'SURVIVOR', project: 'p' }]);

    appendObservation({ ts: 3, tool: 'AFTER_PURGE', project: 'p' }, dir);

    expect(loadRecentObservations(dir, 3, 'p').map((o) => o.tool)).toEqual([
      'AFTER_PURGE',
      'SURVIVOR',
      'SHRUNK',
    ]);
  });
});
