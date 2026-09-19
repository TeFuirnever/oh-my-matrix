/**
 * instinct store: instincts.jsonl family — append with exact-text dedup,
 * hits accumulation, scope-filtered load (ticket-09).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendInstinct,
  loadInstincts,
  purgeExpired,
  getWriteFailureCount,
  _resetForTest,
  type Instinct,
} from '../src/store';

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instinct-instincts-'));
  _resetForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('appendInstinct', () => {
  it('writes a scrubbed, truncated instinct with hits=1', () => {
    appendInstinct(dir, { text: 'api_key=sk-1234567890abcdef1234 — always run verify before claiming done', scope: 'project' });
    const file = join(dir, '.instinct', 'instincts.jsonl');
    const stored = JSON.parse(readFileSync(file, 'utf-8')) as Instinct;
    expect(stored.text).toContain('REDACTED');
    expect(stored.text).not.toContain('sk-1234');
    expect(stored.scope).toBe('project');
    expect(stored.hits).toBe(1);
    expect(typeof stored.ts).toBe('number');
  });

  it('dedups on exact text: hit updates ts and increments hits, no new line', () => {
    appendInstinct(dir, { text: 'pnpm verify before done', scope: 'project' });
    const file = join(dir, '.instinct', 'instincts.jsonl');
    const first = (readFileSync(file, 'utf-8').split('\n').filter(Boolean)).map((l) => JSON.parse(l) as Instinct);

    const later = first[0].ts + 5_000;
    appendInstinct(dir, { text: 'pnpm verify before done', scope: 'project' }, later);

    const after = (readFileSync(file, 'utf-8').split('\n').filter(Boolean)).map((l) => JSON.parse(l) as Instinct);
    expect(after).toHaveLength(1); // no duplicate line
    expect(after[0].hits).toBe(2);
    expect(after[0].ts).toBe(later);
  });

  it('does NOT dedup on differing text', () => {
    appendInstinct(dir, { text: 'a', scope: 'project' });
    appendInstinct(dir, { text: 'b', scope: 'project' });
    const lines = readFileSync(join(dir, '.instinct', 'instincts.jsonl'), 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('never throws when the write path is unwritable, and counts the failure', () => {
    // .instinct exists as a FILE → mkdir/append inside it fails.
    writeFileSync(join(dir, '.instinct'), 'not a directory');
    expect(() => appendInstinct(dir, { text: 'x', scope: 'project' })).not.toThrow();
    expect(getWriteFailureCount()).toBe(1);
  });
});

describe('loadInstincts', () => {
  it('returns [] when nothing is recorded', () => {
    expect(loadInstincts(dir, 10, 'p1')).toEqual([]);
  });

  it('includes global instincts for any project, project-scoped only for their own', () => {
    const t = Date.now();
    appendInstinct(dir, { text: 'g1', scope: 'global' }, t);
    appendInstinct(dir, { text: 'p1-only', scope: 'project' }, t + 1);
    const file = join(dir, '.instinct', 'instincts.jsonl');
    // project-scoped instinct recorded from project p1: patch its project field
    // (appendInstinct stamps the recorder's project; here cwd has no .git → 'unknown').
    // Simulate cross-project by direct edit:
    const lines = (readFileSync(file, 'utf-8').split('\n').filter(Boolean)).map((l) => JSON.parse(l) as Instinct);
    lines.find((i) => i.text === 'p1-only')!.project = 'p1';
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const forP1 = loadInstincts(dir, 10, 'p1').map((i) => i.text);
    expect(forP1).toContain('g1');
    expect(forP1).toContain('p1-only');
    const forP2 = loadInstincts(dir, 10, 'p2').map((i) => i.text);
    expect(forP2).toEqual(['g1']); // project-scoped excluded for other projects
  });

  it('orders by hits desc then ts desc, respecting limit', () => {
    const t = Date.now();
    appendInstinct(dir, { text: 'rare', scope: 'global' }, t);            // hits 1
    appendInstinct(dir, { text: 'common', scope: 'global' }, t + 1);      // hits 1 → 3
    appendInstinct(dir, { text: 'common', scope: 'global' }, t + 2);
    appendInstinct(dir, { text: 'common', scope: 'global' }, t + 3);
    appendInstinct(dir, { text: 'fresh-low-hit', scope: 'global' }, t + 4_000);

    const top2 = loadInstincts(dir, 2).map((i) => i.text);
    expect(top2[0]).toBe('common');       // hits 3 beats everything
    expect(top2[1]).toBe('fresh-low-hit'); // ts desc among hits-1
    expect(top2).not.toContain('rare');    // limit respected
  });
});

describe('purge covers the instincts family', () => {
  it('purges instincts older than 30 days when family is passed', () => {
    const now = Date.now();
    appendInstinct(dir, { text: 'stale', scope: 'global' }, now - 31 * DAY);
    appendInstinct(dir, { text: 'fresh', scope: 'global' }, now);

    purgeExpired(dir, { family: 'instincts', now });
    const texts = loadInstincts(dir, 10).map((i) => i.text);
    expect(texts).toEqual(['fresh']);
    expect(existsSync(join(dir, '.instinct', 'instincts.jsonl'))).toBe(true);
  });
});
