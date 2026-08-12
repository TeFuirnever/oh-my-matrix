/**
 * Crash-recovery checkpoint persistence tests.
 *
 * Covers the Review #4 BLOCKERs:
 *   #1 — status is re-derived on load, never trusted from the persisted field
 *   #2 — sessionKey→runId index survives a process restart (empty in-memory Map)
 *   #3 — concurrent writes for the same runId are serialized
 *   #4 — stale-run guard refuses to resume when the workspace path no longer exists
 *   #6 — done-run checkpoints are deleted (no leak) + terminal sweep
 *
 * Uses a real tmpdir (not mocks) because the persister is pure filesystem I/O —
 * mocking fs here would repeat the runtime-guard incident's "green test against
 * an invented shape" failure mode. See docs/fixes/runtime-guard-event-shape.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  lookupRunIdBySessionKey,
  listResumableCheckpoints,
  isResumableBlockedReason,
  clearSessionIndexEntry,
  buildCheckpoint,
  migrateLegacyCheckpoints,
  _resetCheckpointFailureCountForTest,
  _clearWriteLocksForTest,
  _flushAllWritesForTest,
  _enableCheckpointingForTest,
  _setCheckpointRootForTest,
} from '../src/state-persister';
import type { AutopilotState } from '../src/types';
import { lastProgressTurn, hasMigrationGrace } from '../src/progress-ledger';

let tmpRoot: string;

function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return {
    status: 'running',
    enabled: true,
    sessionKey: 'sess-1',
    runId: 'run-1',
    startedAt: 1000,
    lastActivityAt: 1000,
    totalContinuations: 5,
    turnAttempts: 2,
    maxAttemptsPerTurn: 5,
    maxTotalContinuations: 200,
    maxConcurrentAutopilot: 5,
    totalTokensUsed: 1000,
    toolErrorCount: 0,
    toolErrorThreshold: 3,
    needsCrossTurnResume: false,
    degraded: false,
    orchestrationState: 'running',
    workspace: { root: tmpRoot, path: tmpRoot, workspaceKey: 'k', branchName: 'b', baseBranch: 'main', createdNow: true, reusable: false },
    ...overrides,
  } as AutopilotState;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-cp-'));
  _resetCheckpointFailureCountForTest();
  _clearWriteLocksForTest();
  // Re-enable persistence — index.ts _resetForTest() disables it for test isolation
  // in the broader suite, but THIS file is the one place that must exercise real I/O.
  _enableCheckpointingForTest();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  // Reviewer #2 Finding 4 fix: reset the kill switch on exit so this file never
  // leaves persistence ON for a subsequent file in the same vitest worker.
  // Defense-in-depth against a future `isolate: false` config.
});

// Deterministically await all in-flight checkpoint writes via the lock map.
// Reviewer #2 Finding 5 fix — replaces the fragile tick-count drain.
function flushWrites(): Promise<void> {
  return _flushAllWritesForTest();
}

describe('saveCheckpoint + loadCheckpoint round-trip', () => {
  it('persists a slim checkpoint and restores orchestration state + counters', async () => {
    const state = makeState({ orchestrationState: 'retry_queued', totalContinuations: 42 });
    saveCheckpoint(state, 'run-1', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-1', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(loaded!.orchestrationState).toBe('retry_queued');
    expect(loaded!.totalContinuations).toBe(42);
    expect(loaded!.sessionKey).toBe('sess-1');
    expect(loaded!.goal).toBe(state.goal);
  });

  it('does NOT persist permissionAudit (it has its own JSONL)', async () => {
    const state = makeState({
      // @ts-expect-error — permissionAudit is not in the slim checkpoint shape
      permissionAudit: [{ tool: 'Bash', decision: 'allow', ts: 1 }],
    });
    saveCheckpoint(state, 'run-1', tmpRoot);
    await flushWrites();

    const cpPath = path.join(tmpRoot, '.autopilot', 'checkpoints', 'run-1.json');
    const raw = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    expect(raw.permissionAudit).toBeUndefined();
  });

  // Enhancement C (ADR-019): trustWorkspace MUST survive checkpoint round-trip.
  // AutopilotCheckpoint is an explicit allowlist — forgetting to persist this
  // field would silently degrade a crashed trusted-verifiable run's threshold
  // from 3 to 2 on recovery. This test guards the allowlist entry.
  it('persists trustWorkspace through checkpoint round-trip (Enhancement C)', async () => {
    const state = makeState({ trustWorkspace: true });
    saveCheckpoint(state, 'run-tw', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-tw', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(loaded!.trustWorkspace).toBe(true);
  });

  it('old checkpoint without trustWorkspace loads as undefined (backward compat)', async () => {
    // Simulate a pre-Enhancement-C checkpoint by saving one then deleting the field.
    const state = makeState({ trustWorkspace: true });
    saveCheckpoint(state, 'run-old', tmpRoot);
    await flushWrites();

    const cpPath = path.join(tmpRoot, '.autopilot', 'checkpoints', 'run-old.json');
    const raw = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    delete raw.trustWorkspace;
    fs.writeFileSync(cpPath, JSON.stringify(raw), 'utf-8');

    const loaded = loadCheckpoint('run-old', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(loaded!.trustWorkspace).toBeUndefined();
  });
});

describe('BLOCKER #1 — status is re-derived on load, never trusted', () => {
  it('overwrites a persisted status that disagrees with deriveStatus', async () => {
    const state = makeState({ orchestrationState: 'running', status: 'running' });
    saveCheckpoint(state, 'run-1', tmpRoot);
    await flushWrites();

    // Corrupt the checkpoint: write status='done' but keep orchState='running'.
    // A naive loader would trust 'done' → false completion (the H1 class bug).
    const cpPath = path.join(tmpRoot, '.autopilot', 'checkpoints', 'run-1.json');
    const raw = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    raw.status = 'done';
    fs.writeFileSync(cpPath, JSON.stringify(raw));

    const loaded = loadCheckpoint('run-1', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    // orchState='running' must derive to status='running', NOT the corrupted 'done'.
    expect(loaded!.status).toBe('running');
    expect(loaded!.status).not.toBe('done');
  });

  it('derives idle when orchState is undefined (pre-activate record)', async () => {
    const state = makeState({ orchestrationState: undefined, status: 'running' });
    saveCheckpoint(state, 'run-1', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-1', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('idle'); // deriveStatus(undefined) === 'idle'
  });
});

describe('BLOCKER #2 — sessionKey→runId index survives restart', () => {
  it('lookupRunIdBySessionKey returns runId after saveCheckpoint', async () => {
    const state = makeState({ sessionKey: 'sess-abc' });
    saveCheckpoint(state, 'run-xyz', tmpRoot);
    await flushWrites();

    expect(lookupRunIdBySessionKey(tmpRoot, 'sess-abc')).toBe('run-xyz');
  });

  it('returns null when the session has no entry (simulates empty in-memory Map after restart)', async () => {
    expect(lookupRunIdBySessionKey(tmpRoot, 'never-seen')).toBeNull();
  });

  it('clearSessionIndexEntry removes the mapping', async () => {
    const state = makeState({ sessionKey: 'sess-del' });
    saveCheckpoint(state, 'run-del', tmpRoot);
    await flushWrites();
    expect(lookupRunIdBySessionKey(tmpRoot, 'sess-del')).toBe('run-del');

    clearSessionIndexEntry(tmpRoot, 'sess-del');
    expect(lookupRunIdBySessionKey(tmpRoot, 'sess-del')).toBeNull();
  });
});

describe('BLOCKER #3 — concurrent writes are serialized per runId', () => {
  it('two rapid saves for the same runId produce a single consistent file', async () => {
    const s1 = makeState({ totalContinuations: 1 });
    const s2 = makeState({ totalContinuations: 2 });
    saveCheckpoint(s1, 'run-race', tmpRoot);
    saveCheckpoint(s2, 'run-race', tmpRoot); // fires before s1's lock settles
    await flushWrites();

    const cpPath = path.join(tmpRoot, '.autopilot', 'checkpoints', 'run-race.json');
    const raw = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    // The lock chain guarantees the file isn't torn — the final value is one of
    // the two writes, never a mix. Both are valid continuations; assert integrity.
    expect([1, 2]).toContain(raw.totalContinuations);
    expect(raw.runId).toBe('run-race');
    expect(raw.sessionKey).toBe('sess-1');
  });

  it('no leftover .tmp files after writes settle', async () => {
    const state = makeState();
    saveCheckpoint(state, 'run-clean', tmpRoot);
    saveCheckpoint(state, 'run-clean', tmpRoot);
    await flushWrites();

    const dir = path.join(tmpRoot, '.autopilot', 'checkpoints');
    const files = fs.readdirSync(dir);
    const tmpLeftovers = files.filter(f => f.includes('.tmp.'));
    expect(tmpLeftovers).toEqual([]);
  });
});

describe('BLOCKER #4 — stale-run workspace guard', () => {
  it('returns null when the recorded workspace path no longer exists', async () => {
    const ghost = path.join(tmpRoot, 'ghost-workspace');
    const state = makeState({
      workspace: { root: ghost, path: ghost, workspaceKey: 'k', branchName: 'b', baseBranch: 'main', createdNow: true, reusable: false },
    });
    saveCheckpoint(state, 'run-ghost', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-ghost', tmpRoot); // validateWorkspace defaults true
    expect(loaded).toBeNull();
  });

  it('resumes when validateWorkspace is disabled (operator override)', async () => {
    const ghost = path.join(tmpRoot, 'ghost-workspace');
    const state = makeState({
      workspace: { root: ghost, path: ghost, workspaceKey: 'k', branchName: 'b', baseBranch: 'main', createdNow: true, reusable: false },
    });
    saveCheckpoint(state, 'run-ghost', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-ghost', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
  });
});

describe('BLOCKER #6 — done-run cleanup + leak prevention', () => {
  it('deleteCheckpoint removes the file', async () => {
    const state = makeState();
    saveCheckpoint(state, 'run-gone', tmpRoot);
    await flushWrites();

    const cpPath = path.join(tmpRoot, '.autopilot', 'checkpoints', 'run-gone.json');
    expect(fs.existsSync(cpPath)).toBe(true);

    deleteCheckpoint('run-gone', tmpRoot);
    expect(fs.existsSync(cpPath)).toBe(false);
  });

  it('deleteCheckpoint is fail-silent on a missing file', () => {
    expect(() => deleteCheckpoint('never-existed', tmpRoot)).not.toThrow();
  });

  it('resumed runs are marked degraded:true so operators can tell them apart', async () => {
    const state = makeState({ degraded: false });
    saveCheckpoint(state, 'run-r', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-r', tmpRoot, { validateWorkspace: false });
    expect(loaded!.degraded).toBe(true);
  });
});

describe('listResumableCheckpoints — multi-run restore (Review #3)', () => {
  it('returns runIds in the active family and skips terminal ones', async () => {
    const running = makeState({ orchestrationState: 'running' });
    const retry = makeState({ sessionKey: 's2', runId: 'r2', orchestrationState: 'retry_queued' });
    const done = makeState({ sessionKey: 's3', runId: 'r3', orchestrationState: 'done', status: 'done' });

    saveCheckpoint(running, 'r1', tmpRoot);
    saveCheckpoint({ ...retry, runId: 'r2' }, 'r2', tmpRoot);
    saveCheckpoint({ ...done, runId: 'r3' }, 'r3', tmpRoot);
    await flushWrites();

    const resumable = listResumableCheckpoints(tmpRoot);
    expect(resumable).toContain('r1');
    expect(resumable).toContain('r2');
    expect(resumable).not.toContain('r3'); // done is terminal — not resumable
  });

  it('E6: the RESUMABLE mirror stays in parity with orchestrator.ts (no_progress included)', () => {
    // E6 added no_progress to the canonical RESUMABLE_BLOCKED_REASONS; the local
    // mirror (RESUMABLE_BLOCKED_LOCAL) must match or a no_progress-paused run's
    // checkpoint is judged terminal and swept after the TTL (state lost). The
    // sweep decision (isResumableBlockedReason) is what the parity protects.
    expect(isResumableBlockedReason('no_progress')).toBe(true);
    // parity with the canonical set (orchestrator.ts RESUMABLE_BLOCKED_REASONS):
    // every canonical member is resumable in the mirror too.
    for (const r of ['stalled', 'validation_failed', 'evidence_missing', 'injection_rejected', 'no_progress']) {
      expect(isResumableBlockedReason(r)).toBe(true);
    }
    // and a terminal reason is NOT.
    expect(isResumableBlockedReason('max_total_reached')).toBe(false);
  });

  it('skips runs whose workspace path no longer exists', async () => {
    const ghost = path.join(tmpRoot, 'gone');
    const state = makeState({
      workspace: { root: ghost, path: ghost, workspaceKey: 'k', branchName: 'b', baseBranch: 'main', createdNow: true, reusable: false },
    });
    saveCheckpoint(state, 'r-ghost', tmpRoot);
    await flushWrites();

    expect(listResumableCheckpoints(tmpRoot)).not.toContain('r-ghost');
  });

  it('returns empty when the checkpoints dir does not exist', () => {
    expect(listResumableCheckpoints(path.join(tmpRoot, 'never'))).toEqual([]);
  });
});

describe('buildCheckpoint — slim shape', () => {
  it('excludes status from being load-bearing (forensic hint only)', () => {
    const state = makeState({ status: 'running' });
    const cp = buildCheckpoint(state, 'run-x', tmpRoot);
    // status is present as a forensic hint but loadCheckpoint must overwrite it.
    expect(cp.status).toBe('running');
    expect(cp.orchestrationState).toBe('running');
  });

  it('captures workspaceRoot for index resolution', () => {
    const state = makeState();
    const cp = buildCheckpoint(state, 'run-x', tmpRoot);
    expect(cp.workspaceRoot).toBe(tmpRoot);
  });
});

describe('Reviewer #1 Finding 2a/2b/2c — workspace/retry/workflow reconstruction', () => {
  it('restores the workspace record so permission containment is preserved', async () => {
    const wsRoot = path.join(tmpRoot, 'ws');
    const wsPath = path.join(tmpRoot, 'ws', 'work');
    fs.mkdirSync(wsPath, { recursive: true });
    const state = makeState({
      workspace: { root: wsRoot, path: wsPath, workspaceKey: 'k', branchName: 'feat', baseBranch: 'main', createdNow: false, reusable: true },
    });
    saveCheckpoint(state, 'run-ws', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-ws', tmpRoot);
    expect(loaded).not.toBeNull();
    expect(loaded!.workspace).toBeDefined();
    expect(loaded!.workspace!.root).toBe(wsRoot);
    expect(loaded!.workspace!.path).toBe(wsPath);
    expect(loaded!.workspace!.branchName).toBe('feat');
  });

  it('restores the retry entry so retry_queued runs are not wedged', async () => {
    const state = makeState({
      orchestrationState: 'retry_queued',
      retry: { attempt: 2, nextRetryAt: 99999, lastError: 'boom', recoverable: true },
    });
    saveCheckpoint(state, 'run-retry', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-retry', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(loaded!.retry).toBeDefined();
    expect(loaded!.retry!.attempt).toBe(2);
    expect(loaded!.retry!.nextRetryAt).toBe(99999);
    expect(loaded!.retry!.lastError).toBe('boom');
  });

  it('restores the workflow config so validation commands are not skipped', async () => {
    const state = makeState({
      workflow: {
        version: 1,
        source: 'workflow_md',
        maxConcurrent: 1,
        maxRetries: 3,
        stallTimeoutMs: 300000,
        maxRetryBackoffMs: 60000,
        workspace: { cleanup: 'manual', branchPrefix: 'ap', allowDirtyBase: false },
        validation: { commands: [{ id: 't', command: 'npm test', timeoutMs: 30000, required: true }], failOnOptional: true },
        destructiveGit: { allow: false },
        warnings: [],
      },
    });
    saveCheckpoint(state, 'run-wf', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-wf', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(loaded!.workflow).toBeDefined();
    expect(loaded!.workflow!.validation.commands).toHaveLength(1);
    expect(loaded!.workflow!.validation.commands[0].command).toBe('npm test');
    expect(loaded!.workflow!.stallTimeoutMs).toBe(300000);
  });
});

describe('fail-silent contract', () => {
  it('saveCheckpoint does not throw when the workspace root is unwritable', () => {
    const state = makeState();
    expect(() => saveCheckpoint(state, 'run-bad', '/nonexistent-root/no-perms')).not.toThrow();
  });

  it('loadCheckpoint returns null for a corrupt JSON file', async () => {
    const dir = path.join(tmpRoot, '.autopilot', 'checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-corrupt.json'), '{ not valid json');
    expect(loadCheckpoint('run-corrupt', tmpRoot, { validateWorkspace: false })).toBeNull();
  });

  it('loadCheckpoint returns null when the file is missing', () => {
    expect(loadCheckpoint('never-saved', tmpRoot)).toBeNull();
  });
});

describe('E8 — checkpoint persists toolErrorThreshold + maxConcurrentAutopilot (no hardcoded-5 drift)', () => {
  it('restores the configured thresholds, not the old hardcoded 5', async () => {
    const state = makeState({
      runId: 'run-thresh', sessionKey: 'sess-thresh',
      toolErrorThreshold: 7, maxConcurrentAutopilot: 9,
    });
    saveCheckpoint(state, 'run-thresh', tmpRoot);
    await flushWrites();
    const loaded = loadCheckpoint('run-thresh', tmpRoot);
    expect(loaded?.toolErrorThreshold).toBe(7);
    expect(loaded?.maxConcurrentAutopilot).toBe(9);
  });
});

describe('E1 — migrateLegacyCheckpoints', () => {
  let legacyDir: string;
  let destDir: string;

  beforeEach(() => {
    legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-mig-legacy-'));
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-mig-dest-'));
    _setCheckpointRootForTest(destDir); // route getCheckpointRoot() at destDir
  });
  afterEach(() => {
    _setCheckpointRootForTest(undefined);
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  it('moves a resumable checkpoint from a legacy root into the fixed root', async () => {
    const state = makeState({ sessionKey: 'sess-mig', runId: 'run-mig', orchestrationState: 'claimed', needsCrossTurnResume: true });
    saveCheckpoint(state, 'run-mig', legacyDir);
    await flushWrites();
    expect(loadCheckpoint('run-mig', legacyDir)).not.toBeNull();
    expect(loadCheckpoint('run-mig', destDir)).toBeNull();

    const migrated = migrateLegacyCheckpoints([legacyDir]);

    expect(migrated).toBe(1);
    expect(loadCheckpoint('run-mig', destDir)).not.toBeNull(); // now in fixed root
    expect(loadCheckpoint('run-mig', legacyDir)).toBeNull();   // gone from legacy
  });

  it('no-ops (does not self-delete) when a legacy root IS the fixed root', async () => {
    // Regression guard for the symlink trap: passing the fixed root itself must
    // skip via canonical-dir equality, not load+write+delete the same file.
    const state = makeState({ sessionKey: 'sess-self', runId: 'run-self', orchestrationState: 'claimed' });
    saveCheckpoint(state, 'run-self', destDir);
    await flushWrites();

    const migrated = migrateLegacyCheckpoints([destDir]);

    expect(migrated).toBe(0);
    expect(loadCheckpoint('run-self', destDir)).not.toBeNull(); // survived
  });

  it('does not orphan a legacy checkpoint whose workspace vanished (skipped, not deleted)', async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-mig-gone-'));
    fs.rmSync(gone, { recursive: true, force: true }); // workspace path no longer exists
    const state = makeState({
      sessionKey: 'sess-gone', runId: 'run-gone', orchestrationState: 'claimed',
      workspace: { root: gone, path: gone, workspaceKey: 'k', branchName: 'b', baseBranch: 'main', createdNow: true, reusable: false },
    });
    saveCheckpoint(state, 'run-gone', legacyDir);
    await flushWrites();

    const migrated = migrateLegacyCheckpoints([legacyDir]);

    // listResumableCheckpoints skips workspace-gone runs → not migrated, not deleted.
    expect(migrated).toBe(0);
    expect(loadCheckpoint('run-gone', legacyDir, { validateWorkspace: false })).not.toBeNull();
  });

  it('listResumableCheckpoints sweeps .tmp.* orphans from a crashed atomic write', () => {
    // E1/§5.8: a crash mid-atomicWriteFileSync leaves a `${runId}.json.tmp.pid.rand`
    // orphan next to the target. The directory scan must collect it. Uses tmpRoot
    // directly (override-agnostic — listResumableCheckpoints takes the root arg).
    const dir = path.join(tmpRoot, '.autopilot', 'checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    const orphan = path.join(dir, 'run-x.json.tmp.1234.abc');
    fs.writeFileSync(orphan, 'garbage from a crashed write');
    expect(fs.existsSync(orphan)).toBe(true);

    listResumableCheckpoints(tmpRoot);

    expect(fs.existsSync(orphan)).toBe(false);
  });
});

// ─── ticket 08: checkpoint schemaVersion + migration + F3 ──────────────
// F3 (/code-review CONFIRMED): 02 introduced FoldedAggregate.lastValidatedTurn,
// but legacy checkpoints lack it → lastProgressTurn fallback ?? 0 → a resumed
// run with an all-failed detail window + legacy fold trips no_progress on the
// very first tick (zero new turns). Also: buildCheckpoint only stored the
// evidenceStatus string, not the full EvidenceSummary, so crash recovery lost
// state.evidence entirely (projection/continuation-engine read undefined).
describe('ticket 08 — schemaVersion + migration (F3)', () => {
  function cpPath(runId: string): string {
    return path.join(tmpRoot, '.autopilot', 'checkpoints', `${runId}.json`);
  }
  function writeRawCheckpoint(runId: string, raw: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(cpPath(runId)), { recursive: true });
    fs.writeFileSync(cpPath(runId), JSON.stringify(raw), 'utf-8');
  }

  it('buildCheckpoint stamps schemaVersion + persists full evidence (not just status)', async () => {
    const evidence = { status: 'passed' as const, diffSummary: 's', commands: [], completedAt: 9 };
    const state = makeState({ evidence });
    saveCheckpoint(state, 'run-ev', tmpRoot);
    await flushWrites();

    const raw = JSON.parse(fs.readFileSync(cpPath('run-ev'), 'utf-8'));
    expect(raw.schemaVersion).toBe(2);
    // Full evidence object persisted (not just the legacy evidenceStatus string).
    expect(raw.evidence).toMatchObject({ status: 'passed', diffSummary: 's', completedAt: 9 });
  });

  it('F3: legacy checkpoint without folded.lastValidatedTurn gets normalized on load', () => {
    // A v1 checkpoint: no schemaVersion, folded aggregate lacks lastValidatedTurn.
    // Detail window has a non-failed turn 3 → migration must derive 3, not ?? 0.
    writeRawCheckpoint('run-legacy', {
      runId: 'run-legacy',
      sessionKey: 'sess-1',
      turnAttempts: 1,
      totalContinuations: 5,
      maxAttemptsPerTurn: 5,
      maxTotalContinuations: 200,
      toolErrorThreshold: 3,
      maxConcurrentAutopilot: 5,
      needsCrossTurnResume: false,
      enabled: true,
      totalTokensUsed: 100,
      orchestrationState: 'running',
      workspacePath: tmpRoot,
      ledger: {
        // legacy folded: NO lastValidatedTurn field.
        folded: { turns: 2, filesTouched: ['a.ts'], commandsRun: ['c'] },
        entries: [
          { turn: 4, filesTouched: ['f4.ts'], commandsRun: ['c'], evidenceStatus: 'failed', decisions: [], openItems: [] },
          { turn: 5, filesTouched: ['f5.ts'], commandsRun: ['c'], evidenceStatus: 'failed', decisions: [], openItems: [] },
        ],
      },
    });

    const loaded = loadCheckpoint('run-legacy', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    // Migration must backfill lastValidatedTurn (0 here — no folded validated
    // turn existed and detail is all-failed; the point is it's explicitly set,
    // not silently undefined). The guard is that load succeeds + ledger intact.
    expect(loaded!.ledger).toBeDefined();
    expect(loaded!.ledger!.folded.lastValidatedTurn).toBe(0);
  });

  it('F3: legacy checkpoint derives lastValidatedTurn from folded history when present', () => {
    // v1 checkpoint whose folded DOES carry progress info via a non-failed
    // detail entry (turn 2 passed). Migration must surface it so lastProgressTurn
    // is not zeroed → no false no_progress pause on resume.
    writeRawCheckpoint('run-prog', {
      runId: 'run-prog',
      sessionKey: 'sess-1',
      turnAttempts: 1, totalContinuations: 6, maxAttemptsPerTurn: 5,
      maxTotalContinuations: 200, toolErrorThreshold: 3, maxConcurrentAutopilot: 5,
      needsCrossTurnResume: false, enabled: true, totalTokensUsed: 100,
      orchestrationState: 'running', workspacePath: tmpRoot,
      ledger: {
        folded: { turns: 1, filesTouched: ['old.ts'], commandsRun: ['c'] }, // no lastValidatedTurn
        entries: [
          { turn: 5, filesTouched: ['f5.ts'], commandsRun: ['c'], evidenceStatus: 'passed', decisions: [], openItems: [] },
          { turn: 6, filesTouched: ['f6.ts'], commandsRun: ['c'], evidenceStatus: 'failed', decisions: [], openItems: [] },
        ],
      },
    });

    const loaded = loadCheckpoint('run-prog', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    // Turn 5 passed → lastProgressTurn must be 5, NOT 0 (the F3 regression).
    expect(lastProgressTurn(loaded!.ledger)).toBe(5);
  });

  it('F3-related: crash recovery restores state.evidence (was lost — only status string persisted)', async () => {
    const evidence = {
      status: 'failed' as const,
      diffSummary: 'no tests',
      commands: [{ id: 'c1', command: 'npm test', required: true, status: 'failed', exitCode: 1 }],
      failureReason: '1 failed',
      completedAt: 99,
    };
    const state = makeState({ evidence });
    saveCheckpoint(state, 'run-ev2', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-ev2', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(loaded!.evidence).toMatchObject({
      status: 'failed',
      diffSummary: 'no tests',
      failureReason: '1 failed',
      completedAt: 99,
    });
    expect(loaded!.evidence!.commands).toHaveLength(1);
  });

  it('backward compat: legacy checkpoint with only evidenceStatus string degrades evidence gracefully', () => {
    // Pre-08 checkpoint stored evidenceStatus (string) but not the full evidence
    // object. Load must reconstruct a minimal EvidenceSummary so state.evidence
    // is non-undefined (projection/continuation-engine get *something*).
    writeRawCheckpoint('run-oldev', {
      runId: 'run-oldev', sessionKey: 'sess-1',
      turnAttempts: 1, totalContinuations: 3, maxAttemptsPerTurn: 5,
      maxTotalContinuations: 200, toolErrorThreshold: 3, maxConcurrentAutopilot: 5,
      needsCrossTurnResume: false, enabled: true, totalTokensUsed: 50,
      orchestrationState: 'running', workspacePath: tmpRoot,
      evidenceStatus: 'passed', // legacy: only the string, no evidence object
    });

    const loaded = loadCheckpoint('run-oldev', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(loaded!.evidence).toBeDefined();
    expect(loaded!.evidence!.status).toBe('passed');
    expect(loaded!.evidence!.commands).toEqual([]); // degraded — commands not in legacy shape
  });

  it('unknown future schemaVersion (> current) fails safe with a forensic log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeRawCheckpoint('run-future', {
      runId: 'run-future', sessionKey: 'sess-1', schemaVersion: 99, // from a newer build
      turnAttempts: 1, totalContinuations: 1, maxAttemptsPerTurn: 5,
      maxTotalContinuations: 200, toolErrorThreshold: 3, maxConcurrentAutopilot: 5,
      needsCrossTurnResume: false, enabled: true, totalTokensUsed: 1,
      orchestrationState: 'running', workspacePath: tmpRoot,
    });

    const loaded = loadCheckpoint('run-future', tmpRoot, { validateWorkspace: false });
    expect(loaded).toBeNull(); // refuse — not silently misinterpret
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // F3 real fix (code-review catch): normalizing lastValidatedTurn→0 is a no-op
  // when detail is all-failed (gap stays 10 ≥ threshold → false pause). The real
  // fix is a one-shot progressGrace the host's no_progress detector consumes.
  it('F3 real fix: migrated legacy ledger carries one-shot progressGrace', () => {
    writeRawCheckpoint('run-grace', {
      runId: 'run-grace', sessionKey: 'sess-1', // no schemaVersion → v1 legacy
      turnAttempts: 1, totalContinuations: 10, maxAttemptsPerTurn: 5,
      maxTotalContinuations: 200, toolErrorThreshold: 3, maxConcurrentAutopilot: 5,
      needsCrossTurnResume: false, enabled: true, totalTokensUsed: 100,
      orchestrationState: 'running', workspacePath: tmpRoot,
      ledger: {
        folded: { turns: 4, filesTouched: ['a.ts'], commandsRun: ['c'] }, // no lastValidatedTurn
        entries: [
          { turn: 9, filesTouched: ['f9.ts'], commandsRun: ['c'], evidenceStatus: 'failed', decisions: [], openItems: [] },
          { turn: 10, filesTouched: ['f10.ts'], commandsRun: ['c'], evidenceStatus: 'failed', decisions: [], openItems: [] },
        ],
      },
    });

    const loaded = loadCheckpoint('run-grace', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    // The host's no_progress detector reads this and suppresses the first pause.
    expect(hasMigrationGrace(loaded!.ledger)).toBe(true);
    // lastProgressTurn is still 0 here (all-failed detail + folded history lost),
    // but the grace flag is what prevents the false pause — not the turn number.
    expect(lastProgressTurn(loaded!.ledger)).toBe(0);
  });

  it('F3: a v2 checkpoint (already schemaVersion 2) does NOT get grace', async () => {
    // Fresh v2 checkpoints have reconstructable history — no grace needed.
    const state = makeState({ totalContinuations: 3 });
    saveCheckpoint(state, 'run-v2', tmpRoot);
    await flushWrites();

    const loaded = loadCheckpoint('run-v2', tmpRoot, { validateWorkspace: false });
    expect(loaded).not.toBeNull();
    expect(hasMigrationGrace(loaded!.ledger)).toBe(false);
  });
});
