/**
 * instinct store: scrub + append + load + rotation + project-id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  scrubSecrets,
  appendObservation,
  loadRecentObservations,
  projectId,
  _resetForTest,
} from '../src/store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instinct-'));
  _resetForTest();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('scrubSecrets', () => {
  it('redacts API keys / tokens', () => {
    expect(scrubSecrets('api_key=sk-1234567890abcdef1234567890')).toContain('REDACTED');
    expect(scrubSecrets('token: ghp_aaaaaaaaaaaaaaaaaaaa1234')).toContain('REDACTED');
  });
  it('redacts bearer tokens', () => {
    expect(scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1')).toContain('REDACTED');
  });
  it('redacts private key blocks', () => {
    const pk = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----';
    expect(scrubSecrets(pk)).toBe('REDACTED_PRIVATE_KEY');
  });
  it('leaves non-secret text intact', () => {
    expect(scrubSecrets('run pnpm test in the auth module')).toBe('run pnpm test in the auth module');
  });
});

describe('appendObservation + loadRecentObservations', () => {
  it('round-trips a scrubbed observation', () => {
    appendObservation(
      { ts: 1, tool: 'Bash', input: 'api_key=sk-secret1234567890ab', project: 'p1' },
      dir,
    );
    const loaded = loadRecentObservations(dir, 10, 'p1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tool).toBe('Bash');
    expect(loaded[0].input).toContain('REDACTED');
    expect(loaded[0].input).not.toContain('sk-secret');
  });

  it('scopes by project id', () => {
    appendObservation({ ts: 1, tool: 'A', project: 'p1' }, dir);
    appendObservation({ ts: 2, tool: 'B', project: 'p2' }, dir);
    expect(loadRecentObservations(dir, 10, 'p1')).toHaveLength(1);
    expect(loadRecentObservations(dir, 10, 'p2')).toHaveLength(1);
    expect(loadRecentObservations(dir, 10).length).toBe(2); // all projects
  });

  it('returns newest first and respects limit', () => {
    for (let i = 0; i < 5; i++) appendObservation({ ts: i, tool: `t${i}`, project: 'p' }, dir);
    const loaded = loadRecentObservations(dir, 3, 'p');
    expect(loaded).toHaveLength(3);
    expect(loaded[0].ts).toBe(4); // newest
    expect(loaded[2].ts).toBe(2);
  });

  it('returns [] when no observations exist', () => {
    expect(loadRecentObservations(dir, 10)).toEqual([]);
  });
});

describe('projectId', () => {
  it('returns a 12-char hex from a .git/config remote', () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/x/y.git\n');
    const id = projectId(dir);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
  it('returns "unknown" when .git is absent', () => {
    expect(projectId(dir)).toBe('unknown');
  });
});
