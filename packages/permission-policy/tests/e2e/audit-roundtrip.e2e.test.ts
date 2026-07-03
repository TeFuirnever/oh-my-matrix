/**
 * T14 E2E: real JSONL audit round-trip + the cross-plugin shared-format contract.
 *
 * This is the integration layer the existing audit-persister.test.ts (unit) does
 * not fully exercise. It proves THREE production contracts that both plugins'
 * audit consumers depend on:
 *
 *  1. ROUND-TRIP — appendAuditEntry writes a REAL file to
 *     <workspace>/.autopilot/audit-YYYY-MM-DD.jsonl on disk (no fs mocking),
 *     and loadRecentAuditEntries reads those exact entries back.
 *
 *  2. 10MB ROTATION — when the current day's file is >= MAX_FILE_BYTES (10MB),
 *     getAuditFilePath rolls to the suffix form audit-DATE-N.jsonl (N starts
 *     at 1). We write a real >10MB base file and assert the next append lands
 *     in audit-DATE-1.jsonl. This is the exact rotation trigger/suffix
 *     (audit-persister.ts: stat.size >= MAX_FILE_BYTES → `-${suffix}.jsonl`).
 *
 *  3. CROSS-PLUGIN SHARED SHAPE — the entry persisted to disk round-trips with
 *     EVERY field of PermissionAuditEntry intact. This is the schema contract
 *     between @oh-my-matrix/permission-policy (writer), @oh-my-matrix/autopilot
 *     (writer), and @oh-my-matrix/dynamic-workflows (writer) — drift here
 *     breaks all three consumers silently. We assert the on-disk key set equals
 *     the PermissionAuditEntry interface (no field dropped, no extra key).
 *
 * Plus: malformed lines skipped, missing dir returns [].
 *
 * Template: packages/permission-policy/tests/audit-persister.test.ts (mkdtempSync/
 * rmSync). This suite covers the rotation + cross-plugin format contract that
 * the unit suite does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  appendAuditEntry,
  loadRecentAuditEntries,
  getAuditFilePath,
  _todayStringForTest,
} from '../../src/audit-persister';
import type { PermissionAuditEntry, CommandClass } from '../../src/types';

const AUDIT_SUBDIR = '.autopilot';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — must match audit-persister.ts

function makeEntry(overrides: Partial<PermissionAuditEntry> = {}): PermissionAuditEntry {
  return {
    at: 1_700_000_000_000,
    runId: 'run-e2e-001',
    toolName: 'exec',
    commandClass: 'workspace_write',
    outcome: 'allow',
    reason: 'e2e round-trip entry',
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-e2e-roundtrip-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('E2E audit round-trip — append → real JSONL file → load', () => {
  it('appendAuditEntry creates <workspace>/.autopilot/audit-YYYY-MM-DD.jsonl on disk (REAL fs)', () => {
    appendAuditEntry(makeEntry({ toolName: 'roundtrip-1' }), tmpDir);

    const today = _todayStringForTest(new Date());
    const expectedPath = path.join(tmpDir, AUDIT_SUBDIR, `audit-${today}.jsonl`);
    expect(fs.existsSync(expectedPath)).toBe(true);

    // loadRecentAuditEntries returns the exact entry back.
    const loaded = loadRecentAuditEntries(tmpDir, 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].toolName).toBe('roundtrip-1');
  });

  it('multiple appends accumulate in one file and load returns them in chronological order', () => {
    for (let i = 0; i < 5; i++) {
      appendAuditEntry(makeEntry({ toolName: `t-${i}`, at: 1000 + i }), tmpDir);
    }
    const loaded = loadRecentAuditEntries(tmpDir, 100);
    expect(loaded).toHaveLength(5);
    // Chronological: oldest first, newest last.
    expect(loaded[0].toolName).toBe('t-0');
    expect(loaded[4].toolName).toBe('t-4');
  });

  it('loadRecentAuditEntries returns [] when the .autopilot dir does not exist', () => {
    expect(loadRecentAuditEntries(tmpDir, 10)).toEqual([]);
    // Confirm no dir was created by the read path.
    expect(fs.existsSync(path.join(tmpDir, AUDIT_SUBDIR))).toBe(false);
  });

  it('malformed JSONL lines are skipped; valid lines on either side still load', () => {
    const today = _todayStringForTest(new Date());
    const filePath = path.join(tmpDir, AUDIT_SUBDIR, `audit-${today}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(makeEntry({ toolName: 'good-before' })) + '\n' +
        '{ this is : not valid json\n' +
        JSON.stringify(makeEntry({ toolName: 'good-after' })) + '\n' +
        '<<<totally broken>>>\n',
      'utf-8',
    );

    const loaded = loadRecentAuditEntries(tmpDir, 10);
    expect(loaded.map((e) => e.toolName)).toEqual(['good-before', 'good-after']);
  });
});

describe('E2E 10MB rotation — real >10MB base file rolls to audit-DATE-N.jsonl', () => {
  // Rotation trigger (audit-persister.ts:getAuditFilePath):
  //   while exists(candidate) && stat.size >= MAX_FILE_BYTES → candidate = `audit-DATE-${suffix}.jsonl`, suffix from 1.
  // So a base file AT OR OVER 10MB forces the next append into audit-DATE-1.jsonl.

  it('getAuditFilePath returns the base file when it does not yet exist', () => {
    const p = getAuditFilePath(tmpDir);
    const today = _todayStringForTest(new Date());
    expect(p).toBe(path.join(tmpDir, AUDIT_SUBDIR, `audit-${today}.jsonl`));
  });

  it('getAuditFilePath returns the base file when it is UNDER 10MB', () => {
    const today = _todayStringForTest(new Date());
    const dir = path.join(tmpDir, AUDIT_SUBDIR);
    const base = path.join(dir, `audit-${today}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(base, 'x'.repeat(1024), 'utf-8'); // 1KB, well under 10MB

    expect(getAuditFilePath(tmpDir)).toBe(base);
  });

  it('a base file >= 10MB rolls the NEXT getAuditFilePath to audit-DATE-1.jsonl (suffix starts at 1)', () => {
    const today = _todayStringForTest(new Date());
    const dir = path.join(tmpDir, AUDIT_SUBDIR);
    const base = path.join(dir, `audit-${today}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    // Write EXACTLY 10MB — the trigger is stat.size >= MAX_FILE_BYTES (>=, not >).
    fs.writeFileSync(base, 'x'.repeat(MAX_FILE_BYTES), 'utf-8');

    const rotated = getAuditFilePath(tmpDir);
    expect(rotated).toBe(path.join(dir, `audit-${today}-1.jsonl`));
  });

  it('appendAuditEntry lands in the rotated file when the base file is already >= 10MB', () => {
    const today = _todayStringForTest(new Date());
    const dir = path.join(tmpDir, AUDIT_SUBDIR);
    const base = path.join(dir, `audit-${today}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    // Pre-fill the base file past 10MB with real bytes.
    fs.writeFileSync(base, 'x'.repeat(MAX_FILE_BYTES + 1024), 'utf-8');

    appendAuditEntry(makeEntry({ toolName: 'rotated-write' }), tmpDir);

    const rotatedPath = path.join(dir, `audit-${today}-1.jsonl`);
    expect(fs.existsSync(rotatedPath)).toBe(true);
    expect(fs.existsSync(base)).toBe(true);

    // The rotated file holds the new entry; loadRecentAuditEntries sees it.
    // Strict assertion: the base file holds 10MB of NON-JSON garbage ('x' bytes),
    // so it must contribute zero parsed entries. If loadRecentAuditEntries ever
    // regressed to surface garbage-parsed or stale entries, a mere `.some()`
    // existence check would still pass — assert exclusivity instead.
    const loaded = loadRecentAuditEntries(tmpDir, 10);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].toolName).toBe('rotated-write');
  });

  it('a second rotation (audit-DATE-1 also >= 10MB) rolls to audit-DATE-2.jsonl', () => {
    const today = _todayStringForTest(new Date());
    const dir = path.join(tmpDir, AUDIT_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    // Both base and -1 are over 10MB → next write goes to -2.
    fs.writeFileSync(path.join(dir, `audit-${today}.jsonl`), 'x'.repeat(MAX_FILE_BYTES), 'utf-8');
    fs.writeFileSync(path.join(dir, `audit-${today}-1.jsonl`), 'x'.repeat(MAX_FILE_BYTES), 'utf-8');

    expect(getAuditFilePath(tmpDir)).toBe(path.join(dir, `audit-${today}-2.jsonl`));
  });
});

describe('E2E cross-plugin shared format — on-disk entry matches PermissionAuditEntry exactly', () => {
  // This is the schema contract between @oh-my-matrix/permission-policy (writer),
  // @oh-my-matrix/autopilot (writer), and @oh-my-matrix/dynamic-workflows (writer).
  // The persisted JSON key set MUST equal the PermissionAuditEntry interface —
  // no field dropped, no extra key, every value type preserved. Drift here
  // silently breaks every audit consumer.

  it('every PermissionAuditEntry field round-trips through disk with its value + type intact', () => {
    // Populate ALL fields of the interface (required + optional).
    const fullEntry: PermissionAuditEntry = {
      at: 1_700_000_001_000,
      runId: 'run-cross-plugin',
      toolName: 'exec',
      commandClass: 'destructive_git',
      outcome: 'block',
      reason: 'cross-plugin format contract',
      cwd: '/workspace/proj',
      commandSummary: 'git reset --hard HEAD~1',
    };
    appendAuditEntry(fullEntry, tmpDir);

    const filePath = getAuditFilePath(tmpDir);
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // The interface field set — single source of truth for the cross-plugin contract.
    const expectedKeys: (keyof PermissionAuditEntry)[] = [
      'at', 'runId', 'toolName', 'commandClass', 'outcome', 'reason', 'cwd', 'commandSummary',
    ];
    expect(Object.keys(parsed).sort()).toEqual([...expectedKeys].sort());

    // Each value round-trips with the correct type.
    expect(parsed.at).toBe(fullEntry.at);
    expect(typeof parsed.at).toBe('number');
    expect(parsed.runId).toBe(fullEntry.runId);
    expect(typeof parsed.runId).toBe('string');
    expect(parsed.toolName).toBe(fullEntry.toolName);
    expect(parsed.commandClass).toBe(fullEntry.commandClass);
    expect(parsed.outcome).toBe(fullEntry.outcome);
    expect(parsed.reason).toBe(fullEntry.reason);
    expect(parsed.cwd).toBe(fullEntry.cwd);
    expect(parsed.commandSummary).toBe(fullEntry.commandSummary);
  });

  it('every CommandClass value is persistable + loadable (exhaustive over the union)', () => {
    const allClasses: CommandClass[] = [
      'read_only', 'workspace_write', 'validation', 'safe_git', 'worktree_create',
      'workspace_cleanup', 'destructive_git', 'network', 'credential_access',
      'system_write', 'unknown',
    ];
    for (const cc of allClasses) {
      appendAuditEntry(makeEntry({ runId: `cc-${cc}`, commandClass: cc }), tmpDir);
    }
    const loaded = loadRecentAuditEntries(tmpDir, allClasses.length);
    expect(loaded).toHaveLength(allClasses.length);
    // Each declared class survives the round-trip (no serialization loss).
    const loadedClasses = new Set(loaded.map((e) => e.commandClass));
    for (const cc of allClasses) {
      expect(loadedClasses.has(cc)).toBe(true);
    }
  });

  it('every outcome value is persistable (allow / require_approval / block)', () => {
    const outcomes: PermissionAuditEntry['outcome'][] = ['allow', 'require_approval', 'block'];
    for (const o of outcomes) {
      appendAuditEntry(makeEntry({ runId: `out-${o}`, outcome: o }), tmpDir);
    }
    const loaded = loadRecentAuditEntries(tmpDir, outcomes.length);
    const got = new Set(loaded.map((e) => e.outcome));
    for (const o of outcomes) {
      expect(got.has(o)).toBe(true);
    }
  });

  it('optional fields (cwd, commandSummary) can be omitted and the entry still round-trips', () => {
    const minimal: PermissionAuditEntry = {
      at: 1_700_000_002_000,
      runId: 'run-minimal',
      toolName: 'read',
      commandClass: 'read_only',
      outcome: 'allow',
      reason: 'minimal entry',
      // cwd + commandSummary intentionally omitted
    };
    appendAuditEntry(minimal, tmpDir);

    const loaded = loadRecentAuditEntries(tmpDir, 1);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].runId).toBe('run-minimal');
    expect(loaded[0].cwd).toBeUndefined();
    expect(loaded[0].commandSummary).toBeUndefined();
  });
});

describe('F1 regression — rotation returns NEWEST entries, not stale base (valid entries)', () => {
  // The old `.sort().reverse()` + early-`break` returned STALE base entries once
  // the base file rolled: `-1` is newer than base but `'-'(0x2D) < '.'(0x2E)` put
  // it lexically before base, so reverse read base first and the early break
  // never opened `-1`. Existing rotation tests masked this by filling base with
  // invalid JSON (0 parsed entries). This test fills base with VALID entries so
  // the ordering bug is actually exercised.
  it('limit < total: returns the rotated (-1) tail, not stale base entries', () => {
    const today = _todayStringForTest(new Date());
    const dir = path.join(tmpDir, AUDIT_SUBDIR);
    const base = path.join(dir, `audit-${today}.jsonl`);
    const rotated = path.join(dir, `audit-${today}-1.jsonl`);
    fs.mkdirSync(dir, { recursive: true });

    // Base: 300 OLDER valid entries.
    const baseLines =
      Array.from({ length: 300 }, (_, i) =>
        JSON.stringify(makeEntry({ runId: `base-${i}`, toolName: `base-${i}`, at: 1000 + i })),
      ).join('\n') + '\n';
    fs.writeFileSync(base, baseLines, 'utf-8');

    // Rotated -1: 50 NEWER valid entries (written after base filled).
    const rotLines =
      Array.from({ length: 50 }, (_, i) =>
        JSON.stringify(makeEntry({ runId: `rot-${i}`, toolName: `rot-${i}`, at: 2000 + i })),
      ).join('\n') + '\n';
    fs.writeFileSync(rotated, rotLines, 'utf-8');

    // limit=10 must return the NEWEST 10 = rot-40..rot-49, NOT base-290..base-299.
    const loaded = loadRecentAuditEntries(tmpDir, 10);
    expect(loaded).toHaveLength(10);
    expect(loaded.every((e) => e.toolName.startsWith('rot-'))).toBe(true);
    expect(loaded.map((e) => e.toolName)).toEqual(
      Array.from({ length: 10 }, (_, i) => `rot-${40 + i}`),
    );
  });
});
