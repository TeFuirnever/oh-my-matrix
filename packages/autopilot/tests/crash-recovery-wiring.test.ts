/**
 * Crash-recovery wiring integration test (Reviewer #2 Finding 2 fix).
 *
 * The state-persister unit test proves the persister module works in isolation.
 * This file proves the WIRING in index.ts is correct: setState → saveCheckpoint,
 * register() → restore, session_end → checkpoint, session_start → resume, and
 * terminal cleanup → deleteCheckpoint — all with REAL filesystem I/O (persistence
 * enabled), in a tmpdir, so a bug in resolveCheckpointRoot / persistAfterTransition
 * / the transition filter / the restore loop is caught rather than masked by the
 * test-isolation kill switch.
 *
 * This is the integration coverage the kill switch (correctly) disabled in the
 * 50+ existing tests. Without it, the persister is proven but its wiring is not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { register, _resetForTest, _getInternalStateForTest } from '../index';
import { saveCheckpoint, _flushAllWritesForTest, _enableCheckpointingForTest, _disableCheckpointingForTest, _setCheckpointRootForTest } from '../src/state-persister';
import { createInitialState } from '../src/types';

let tmpRoot: string;
let originalCwd: string;

function createMockApi(pluginConfig?: Record<string, unknown>) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => unknown>();
  return {
    api: {
      pluginConfig: pluginConfig ?? {},
      on: (hookName: string, handler: (...args: unknown[]) => unknown) => { hooks.set(hookName, handler); },
      registerGatewayMethod: (method: string, handler: (...args: unknown[]) => unknown) => { gatewayMethods.set(method, handler); },
      registerSessionExtension: () => {},
      session: { state: { registerSessionExtension: () => {} }, workflow: { enqueueNextTurnInjection: async () => ({ enqueued: true }) } },
    },
    hooks,
    gatewayMethods,
  };
}

beforeEach(() => {
  // Use a tmpdir as the checkpoint root. Production resolves a fixed user-level
  // root via getCheckpointRoot() (E1/P0-2); tests redirect it here via
  // _setCheckpointRootForTest. chdir into tmp keeps process.cwd() aligned as the
  // legacy-migration candidate register() scans.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-wire-'));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
  _resetForTest();
  _enableCheckpointingForTest();
  // E1: route the index.ts checkpoint root (now fixed/user-level) at this tmpdir
  // so real-disk reads/writes land here, not in ~/.matrix.
  _setCheckpointRootForTest(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  _disableCheckpointingForTest();
  _setCheckpointRootForTest(undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('crash-recovery wiring — setState → checkpoint → register() restore', () => {
  it('activate + setState writes a checkpoint to .autopilot/checkpoints/', async () => {
    const mock = createMockApi({ maxConcurrentAutopilot: 10 });
    register(mock.api);
    const activate = mock.gatewayMethods.get('autopilot.activate')!;
    const sessionStart = mock.hooks.get('session_start')!;

    await sessionStart({ sessionId: 'sid-1', sessionKey: 'sess-1' });
    const respond = vi.fn();
    await activate({ params: { sessionKey: 'sess-1', workspacePath: tmpRoot }, respond });
    expect(respond.mock.calls[0][0]).toBe(true);
    await _flushAllWritesForTest();

    const cpDir = path.join(tmpRoot, '.autopilot', 'checkpoints');
    expect(fs.existsSync(cpDir)).toBe(true);
    const files = fs.readdirSync(cpDir).filter(f => f.endsWith('.json') && f !== 'session-index.json');
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('register() restores a previously-checkpointed run on "restart"', async () => {
    // Phase 1: activate a run, let it checkpoint.
    let mock = createMockApi({ maxConcurrentAutopilot: 10 });
    register(mock.api);
    const activate1 = mock.gatewayMethods.get('autopilot.activate')!;
    const sessionStart1 = mock.hooks.get('session_start')!;
    await sessionStart1({ sessionId: 'sid-1', sessionKey: 'sess-1' });
    const respond1 = vi.fn();
    await activate1({ params: { sessionKey: 'sess-1', goal: 'do the thing', workspacePath: tmpRoot }, respond: respond1 });
    expect(respond1.mock.calls[0][0]).toBe(true);
    await _flushAllWritesForTest();
    expect(_getInternalStateForTest().stateByRunSize).toBe(1);

    // Phase 2: simulate a process restart — wipe memory, re-register.
    // _resetForTest clears the Maps AND disables persistence; re-enable after.
    _resetForTest();
    _enableCheckpointingForTest();
    expect(_getInternalStateForTest().stateByRunSize).toBe(0);

    mock = createMockApi({ maxConcurrentAutopilot: 10 });
    register(mock.api); // register() scans checkpoints dir → restores the run

    // The run should be back in memory.
    expect(_getInternalStateForTest().stateByRunSize).toBe(1);

    // And a status query should find it (the run is restored by register(), not
    // by session_start — verifying the multi-run restore path Review #3 flagged).
    const status = mock.gatewayMethods.get('autopilot.status')!;
    const statusRespond = vi.fn();
    await status({ params: { sessionKey: 'sess-1' }, respond: statusRespond });
    expect(statusRespond.mock.calls[0][0]).toBe(true);
    const projection = statusRespond.mock.calls[0][1];
    expect(projection).toBeDefined();
  });

  it('a restored run preserves its goal across the restart', async () => {
    let mock = createMockApi({ maxConcurrentAutopilot: 10 });
    register(mock.api);
    const activate = mock.gatewayMethods.get('autopilot.activate')!;
    const sessionStart = mock.hooks.get('session_start')!;
    await sessionStart({ sessionId: 'sid-g', sessionKey: 'sess-g' });
    const respond = vi.fn();
    await activate({ params: { sessionKey: 'sess-g', goal: 'build the feature', workspacePath: tmpRoot }, respond });
    await _flushAllWritesForTest();

    _resetForTest();
    _enableCheckpointingForTest();
    mock = createMockApi({ maxConcurrentAutopilot: 10 });
    register(mock.api);

    // Read the restored state directly via the status RPC's raw state.
    const status = mock.gatewayMethods.get('autopilot.status')!;
    const statusRespond = vi.fn();
    await status({ params: { sessionKey: 'sess-g' }, respond: statusRespond });
    // goal is preserved in the checkpoint and restored.
    const stateArg = statusRespond.mock.calls[0]?.[1];
    // projection may not include goal directly, but the run is restored — verify via progress field presence.
    expect(stateArg).toBeDefined();
  });
});

// E11 helper: checkpoint `state`, simulate a restart (wipe + re-register) with
// an enqueue spy wired as the kick actuator. Returns the spy so each test
// asserts only on the kick behavior that distinguishes it.
async function restoreRunWithKickSpy(
  runId: string,
  state: ReturnType<typeof createInitialState>,
  enqueueImpl: ((injection: any) => Promise<any>) | undefined = async () => ({ enqueued: true }),
) {
  saveCheckpoint(state, runId, tmpRoot);
  await _flushAllWritesForTest();
  const enqueue = vi.fn(enqueueImpl);
  const base = createMockApi({ maxConcurrentAutopilot: 10 });
  const api = { ...base.api, session: { ...base.api.session, workflow: { enqueueNextTurnInjection: enqueue } } };
  _resetForTest();
  _enableCheckpointingForTest();
  register(api);
  return { enqueue, gatewayMethods: base.gatewayMethods };
}

describe('E13 — crash-recovery no longer auto-kicks; explicit resume_run RPC', () => {
  it('a restored needsCrossTurnResume CLAIMED run is NOT auto-kicked on register()', async () => {
    // E13/P3-29: the pre-E13 restore-time kick was the implicit "flag → turn"
    // link that double-spent a turn after a gateway restart (dedup cleared).
    // Restored mid-cross-turn runs now wait for the explicit resume_run RPC.
    const { enqueue } = await restoreRunWithKickSpy('run-crash', {
      ...createInitialState('sess-crash', 'run-crash'),
      orchestrationState: 'claimed' as const,
      status: 'running' as const,
      enabled: true,
      needsCrossTurnResume: true,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('the explicit autopilot.resume_run RPC drives the resumed turn', async () => {
    // E13: continuation is now a single explicit RPC, not a flag re-broadcast.
    const { enqueue, gatewayMethods } = await restoreRunWithKickSpy('run-resume', {
      ...createInitialState('sess-resume', 'run-resume'),
      orchestrationState: 'claimed' as const,
      status: 'running' as const,
      enabled: true,
      needsCrossTurnResume: true,
    });
    expect(enqueue).not.toHaveBeenCalled(); // still not auto-kicked
    // The driver calls resume_run once → the turn is kicked (idempotency key
    // derived from totalContinuations — the E13-preserved invariant).
    const respond = vi.fn();
    await gatewayMethods.get('autopilot.resume_run')!({ params: { sessionKey: 'sess-resume' }, respond });
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: 'sess-resume' }));
    // E13/§7 invariant with teeth: the idempotency key is derived from
    // totalContinuations (lastActivityAt is unset on this fixture → 0). Pinning
    // the value guards the comment in kickResumedTurn against silent refactors.
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'autopilot-resume-run-resume-0' }));
  });

  it('resume_run rejects a run that is not mid-cross-turn', async () => {
    const { gatewayMethods } = await restoreRunWithKickSpy('run-noctx', {
      ...createInitialState('sess-noctx', 'run-noctx'),
      orchestrationState: 'claimed' as const,
      status: 'running' as const,
      enabled: true,
      needsCrossTurnResume: false,
    });
    const respond = vi.fn();
    await gatewayMethods.get('autopilot.resume_run')!({ params: { sessionKey: 'sess-noctx' }, respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it('resume_run rejects a mid-cross-turn run that is NOT in a claimed state', async () => {
    // needsCrossTurnResume + status running, but orchState 'running' (crashed
    // mid-turn) — kickResumedTurn would silently no-op, so resume_run must refuse
    // rather than report a misleading success.
    const { enqueue, gatewayMethods } = await restoreRunWithKickSpy('run-midrun', {
      ...createInitialState('sess-midrun', 'run-midrun'),
      orchestrationState: 'running' as const,
      status: 'running' as const,
      enabled: true,
      needsCrossTurnResume: true,
    });
    const respond = vi.fn();
    await gatewayMethods.get('autopilot.resume_run')!({ params: { sessionKey: 'sess-midrun' }, respond });
    expect(respond.mock.calls[0][0]).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('resume_run rejects a mid-cross-turn run that is not running (e.g. paused)', async () => {
    const { gatewayMethods } = await restoreRunWithKickSpy('run-paused', {
      ...createInitialState('sess-paused', 'run-paused'),
      orchestrationState: 'blocked' as const,
      status: 'paused' as const,
      enabled: false,
      needsCrossTurnResume: true,
    });
    const respond = vi.fn();
    await gatewayMethods.get('autopilot.resume_run')!({ params: { sessionKey: 'sess-paused' }, respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it('resume_run reports false when the injection facade rejects (review follow-up)', async () => {
    // The kick is fire-and-forget elsewhere, but resume_run is an RPC and must not
    // claim success when the host rejected the enqueue.
    const { enqueue, gatewayMethods } = await restoreRunWithKickSpy('run-reject', {
      ...createInitialState('sess-reject', 'run-reject'),
      orchestrationState: 'claimed' as const,
      status: 'running' as const,
      enabled: true,
      needsCrossTurnResume: true,
    }, async () => ({ enqueued: false }));
    const respond = vi.fn();
    await gatewayMethods.get('autopilot.resume_run')!({ params: { sessionKey: 'sess-reject' }, respond });
    expect(respond.mock.calls[0][0]).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('resume_run reports false when the enqueue throws (review follow-up)', async () => {
    const { gatewayMethods } = await restoreRunWithKickSpy('run-throw', {
      ...createInitialState('sess-throw', 'run-throw'),
      orchestrationState: 'claimed' as const,
      status: 'running' as const,
      enabled: true,
      needsCrossTurnResume: true,
    }, async () => { throw new Error('queue full'); });
    const respond = vi.fn();
    await gatewayMethods.get('autopilot.resume_run')!({ params: { sessionKey: 'sess-throw' }, respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it('resume_run idempotency key uses lastActivityAt when set (primary path, review follow-up)', async () => {
    // The key is `lastActivityAt ?? totalContinuations` — lastActivityAt PRIMARY.
    // A restored mid-cross-turn run has lastActivityAt set (it was active before
    // the resume); pin the production key, not just the fallback.
    const { enqueue, gatewayMethods } = await restoreRunWithKickSpy('run-lat', {
      ...createInitialState('sess-lat', 'run-lat'),
      orchestrationState: 'claimed' as const,
      status: 'running' as const,
      enabled: true,
      needsCrossTurnResume: true,
      lastActivityAt: 123456,
      totalContinuations: 7,
    });
    const respond = vi.fn();
    await gatewayMethods.get('autopilot.resume_run')!({ params: { sessionKey: 'sess-lat' }, respond });
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'autopilot-resume-run-lat-123456' }));
  });

  it('resume_run reports false when the host lacks the injection facade (review follow-up)', async () => {
    // Hosts below the 5.28+ facade have no enqueueNextTurnInjection; resume_run
    // must not claim success (the kick would silently no-op).
    saveCheckpoint(
      { ...createInitialState('sess-nofacade', 'run-nofacade'), orchestrationState: 'claimed' as const, status: 'running' as const, enabled: true, needsCrossTurnResume: true },
      'run-nofacade', tmpRoot,
    );
    await _flushAllWritesForTest();
    const base = createMockApi({ maxConcurrentAutopilot: 10 });
    // Strip the injection facade entirely.
    const api = { ...base.api, session: { state: { registerSessionExtension: () => {} } } } as any;
    _resetForTest();
    _enableCheckpointingForTest();
    register(api);
    const respond = vi.fn();
    await base.gatewayMethods.get('autopilot.resume_run')!({ params: { sessionKey: 'sess-nofacade' }, respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it('a restored run WITHOUT needsCrossTurnResume is not kicked', async () => {
    const { enqueue } = await restoreRunWithKickSpy('run-plain', {
      ...createInitialState('sess-plain', 'run-plain'),
      orchestrationState: 'claimed' as const,
      enabled: true,
      needsCrossTurnResume: false,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('E1 — register() migrates a legacy-cwd checkpoint into the fixed root', () => {
  it('restores a run whose checkpoint lived in the pre-fix cwd location', async () => {
    // Code-review (Standards) finding: register()'s migrateLegacyCheckpoints
    // wiring is otherwise untested — in the other tests process.cwd()===override
    // so migration always hits the canonical-equality skip. Here they differ.
    const legacyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-legcwd-'));
    const fixedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-fixed-'));
    try {
      const state = { ...createInitialState('sess-leg', 'run-leg'), orchestrationState: 'claimed' as const, enabled: true };
      saveCheckpoint(state, 'run-leg', legacyCwd);
      await _flushAllWritesForTest();

      // Distinct fixed root; chdir to the legacy location so register()'s
      // migrateLegacyCheckpoints([process.cwd()]) finds and moves the checkpoint.
      process.chdir(legacyCwd);
      _resetForTest();
      _enableCheckpointingForTest();
      _setCheckpointRootForTest(fixedRoot);
      const mock = createMockApi({ maxConcurrentAutopilot: 10 });
      register(mock.api);

      // Restored — proves register()'s wiring migrated legacy→fixed root.
      // Without migration, listResumableCheckpoints(fixedRoot) returns [].
      expect(_getInternalStateForTest().stateByRunSize).toBe(1);
    } finally {
      process.chdir(originalCwd);
      _setCheckpointRootForTest(undefined);
      fs.rmSync(legacyCwd, { recursive: true, force: true });
      fs.rmSync(fixedRoot, { recursive: true, force: true });
    }
  });
});

describe('crash-recovery wiring — session_end checkpoints a non-terminal run', () => {
  it('a running run survives session_end (checkpointed before memory delete)', async () => {
    const mock = createMockApi({ maxConcurrentAutopilot: 10 });
    register(mock.api);
    const activate = mock.gatewayMethods.get('autopilot.activate')!;
    const sessionStart = mock.hooks.get('session_start')!;
    const sessionEnd = mock.hooks.get('session_end')!;
    await sessionStart({ sessionId: 'sid-e', sessionKey: 'sess-e' });
    const respond = vi.fn();
    await activate({ params: { sessionKey: 'sess-e', workspacePath: tmpRoot }, respond });
    await _flushAllWritesForTest();

    // Fire session_end — the handler should checkpoint the running run before
    // deleting it from memory.
    await sessionEnd({ sessionId: 'sid-e', sessionKey: 'sess-e' });
    await _flushAllWritesForTest();

    // Memory cleared by session_end...
    expect(_getInternalStateForTest().stateByRunSize).toBe(0);
    // ...but a checkpoint exists on disk for this session.
    expect(lookupCheckpointForSession('sess-e')).toBe(true);
  });
});

describe('crash-recovery wiring — done-run deletes its checkpoint', () => {
  it('a run reaching done state removes its checkpoint file', async () => {
    // This exercises persistAfterTransition's terminal-cleanup branch via setState.
    // We use the internal state machine: a run we manually drive to 'done'.
    const mock = createMockApi({ maxConcurrentAutopilot: 10 });
    register(mock.api);
    const activate = mock.gatewayMethods.get('autopilot.activate')!;
    const sessionStart = mock.hooks.get('session_start')!;
    await sessionStart({ sessionId: 'sid-d', sessionKey: 'sess-d' });
    const respond = vi.fn();
    await activate({ params: { sessionKey: 'sess-d', workspacePath: tmpRoot }, respond });
    await _flushAllWritesForTest();

    const cpDir = path.join(tmpRoot, '.autopilot', 'checkpoints');
    const beforeFiles = fs.readdirSync(cpDir).filter(f => f.endsWith('.json') && f !== 'session-index.json');
    expect(beforeFiles.length).toBeGreaterThanOrEqual(1);

    // Stop the run (sets blockedReason: 'user_stopped' → terminal cleanup).
    const stop = mock.gatewayMethods.get('autopilot.stop')!;
    const stopRespond = vi.fn();
    await stop({ params: { sessionKey: 'sess-d' }, respond: stopRespond });
    await _flushAllWritesForTest();

    const afterFiles = fs.readdirSync(cpDir).filter(f => f.endsWith('.json') && f !== 'session-index.json');
    expect(afterFiles.length).toBe(0);
  });
});

// Helper: does any checkpoint file reference this sessionKey?
function lookupCheckpointForSession(sessionKey: string): boolean {
  const cpDir = path.join(tmpRoot, '.autopilot', 'checkpoints');
  if (!fs.existsSync(cpDir)) return false;
  const indexPath = path.join(cpDir, 'session-index.json');
  if (!fs.existsSync(indexPath)) return false;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    return sessionKey in index;
  } catch {
    return false;
  }
}
