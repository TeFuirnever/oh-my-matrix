/**
 * TDD: audit-persister — written BEFORE implementation.
 * All tests should FAIL until audit-persister.ts is created.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// This import will fail until the module is created — that's expected in TDD
import {
  appendAuditEntry,
  loadRecentAuditEntries,
  getAuditFilePath,
  _todayStringForTest,
} from '../src/audit-persister';
import type { PermissionAuditEntry } from '../src/types';

function makeEntry(overrides: Partial<PermissionAuditEntry> = {}): PermissionAuditEntry {
  return {
    at: Date.now(),
    runId: 'run-test-001',
    toolName: 'bash',
    commandClass: 'validation',
    outcome: 'allow',
    reason: 'safe command',
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-audit-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getAuditFilePath', () => {
  it('returns path under .autopilot/ subdirectory', () => {
    const p = getAuditFilePath(tmpDir);
    expect(p).toContain('.autopilot');
    expect(p).toMatch(/\.jsonl$/);
  });

  it('includes current date in filename', () => {
    const p = getAuditFilePath(tmpDir);
    const today = _todayStringForTest(new Date()); // use local date, matching implementation
    expect(p).toContain(today);
  });
});

describe('appendAuditEntry', () => {
  it('creates directory if missing', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'workspace');
    const entry = makeEntry();
    appendAuditEntry(entry, nestedDir);
    const filePath = getAuditFilePath(nestedDir);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('writes valid JSON line', () => {
    const entry = makeEntry({ toolName: 'read_file', outcome: 'allow' });
    appendAuditEntry(entry, tmpDir);
    const filePath = getAuditFilePath(tmpDir);
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.toolName).toBe('read_file');
    expect(parsed.outcome).toBe('allow');
    expect(parsed.runId).toBe('run-test-001');
  });

  it('appends multiple entries as separate JSON lines', () => {
    appendAuditEntry(makeEntry({ toolName: 'tool1' }), tmpDir);
    appendAuditEntry(makeEntry({ toolName: 'tool2' }), tmpDir);
    appendAuditEntry(makeEntry({ toolName: 'tool3' }), tmpDir);
    const filePath = getAuditFilePath(tmpDir);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).toolName).toBe('tool1');
    expect(JSON.parse(lines[2]).toolName).toBe('tool3');
  });

  it('preserves all PermissionAuditEntry fields', () => {
    const entry = makeEntry({
      commandClass: 'system_write',
      outcome: 'block',
      reason: 'credential access blocked',
      cwd: '/tmp/workspace',
      commandSummary: 'cat /etc/passwd',
    });
    appendAuditEntry(entry, tmpDir);
    const filePath = getAuditFilePath(tmpDir);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').trim());
    expect(parsed.commandClass).toBe('system_write');
    expect(parsed.outcome).toBe('block');
    expect(parsed.cwd).toBe('/tmp/workspace');
    expect(parsed.commandSummary).toBe('cat /etc/passwd');
  });

  it('does not throw when called rapidly (no race on single file)', () => {
    expect(() => {
      for (let i = 0; i < 20; i++) {
        appendAuditEntry(makeEntry({ toolName: `tool-${i}` }), tmpDir);
      }
    }).not.toThrow();
    const filePath = getAuditFilePath(tmpDir);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(20);
  });
});

describe('loadRecentAuditEntries', () => {
  it('returns empty array when no audit file exists', () => {
    const entries = loadRecentAuditEntries(tmpDir, 10);
    expect(entries).toEqual([]);
  });

  it('returns up to limit entries', () => {
    for (let i = 0; i < 10; i++) {
      appendAuditEntry(makeEntry({ toolName: `tool-${i}` }), tmpDir);
    }
    const entries = loadRecentAuditEntries(tmpDir, 5);
    expect(entries).toHaveLength(5);
  });

  it('returns most recent entries (last written = last in array)', () => {
    for (let i = 0; i < 5; i++) {
      appendAuditEntry(makeEntry({ toolName: `tool-${i}`, at: 1000 + i }), tmpDir);
    }
    const entries = loadRecentAuditEntries(tmpDir, 3);
    expect(entries).toHaveLength(3);
    // Last 3: tool-2, tool-3, tool-4
    expect(entries[2].toolName).toBe('tool-4');
    expect(entries[0].toolName).toBe('tool-2');
  });

  it('returns all entries when fewer than limit', () => {
    appendAuditEntry(makeEntry({ toolName: 'only-one' }), tmpDir);
    const entries = loadRecentAuditEntries(tmpDir, 100);
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe('only-one');
  });

  it('skips malformed lines gracefully', () => {
    const filePath = getAuditFilePath(tmpDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Write one good, one bad, one good
    fs.writeFileSync(filePath,
      JSON.stringify(makeEntry({ toolName: 'good1' })) + '\n' +
      'NOT_VALID_JSON\n' +
      JSON.stringify(makeEntry({ toolName: 'good2' })) + '\n'
    );
    const entries = loadRecentAuditEntries(tmpDir, 10);
    expect(entries).toHaveLength(2);
    expect(entries.map((e: PermissionAuditEntry) => e.toolName)).toContain('good1');
    expect(entries.map((e: PermissionAuditEntry) => e.toolName)).toContain('good2');
  });
});

describe('_todayStringForTest — local date, not UTC', () => {
  it('returns YYYY-MM-DD matching local date parts', () => {
    const result = _todayStringForTest(new Date());
    const d = new Date();
    const expected = [
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
    expect(result).toBe(expected);
  });

  it('uses LOCAL date not UTC — passes a Date where UTC and local differ', () => {
    // Simulate: it's 23:30 UTC on June 9 but 07:30 local on June 10 (UTC+8)
    // We test the logic by constructing a date where UTC date ≠ local date
    const offsetMs = new Date().getTimezoneOffset() * 60_000;
    if (offsetMs === 0) {
      // UTC machine — skip the cross-midnight check, just verify format
      const result = _todayStringForTest(new Date());
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      return;
    }
    // Pick a time where UTC and local are on different days
    const now = new Date();
    const utcMidnight = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0));
    // subtract 1ms from UTC midnight → UTC date is "yesterday" but local is "today" on UTC+ machines
    const crossMidnight = new Date(utcMidnight.getTime() - 1);
    const result = _todayStringForTest(crossMidnight);
    const localDay = String(crossMidnight.getDate()).padStart(2, '0');
    const utcDay = String(crossMidnight.getUTCDate()).padStart(2, '0');
    if (localDay !== utcDay) {
      // Dates differ — verify result matches LOCAL, not UTC
      const localExpected = [
        String(crossMidnight.getFullYear()),
        String(crossMidnight.getMonth() + 1).padStart(2, '0'),
        localDay,
      ].join('-');
      expect(result).toBe(localExpected);
      expect(result).not.toBe(crossMidnight.toISOString().slice(0, 10));
    }
  });
});
