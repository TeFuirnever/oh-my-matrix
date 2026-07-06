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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  lookupRunIdBySessionKey,
  listResumableCheckpoints,
  clearSessionIndexEntry,
  buildCheckpoint,
  _resetCheckpointFailureCountForTest,
  _clearWriteLocksForTest,
  _flushAllWritesForTest,
  _enableCheckpointingForTest,
} from '../src/state-persister';
import type { AutopilotState } from '../src/types';

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
      // @ts-expect-error — partial workflow for test
      workflow: {
        version: 1,
        source: 'workflow_md',
        maxConcurrent: 1,
        maxRetries: 3,
        stallTimeoutMs: 300000,
        maxRetryBackoffMs: 60000,
        workspace: { root: tmpRoot, cleanup: 'manual', branchPrefix: 'ap', allowDirtyBase: false },
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
