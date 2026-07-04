/**
 * T-S6, T-S7, T-SPECIAL, T-S8: audit refCount lifecycle balance tests
 *
 * Each full_yolo session must have balanced setAuditMode calls:
 *   monitor calls === active calls  (net refCount = 0 after session ends)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuditSetMode = vi.fn();

import { register, _resetForTest, _setAuditSetModeForTest } from '../index';

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const hooks = new Map<string, { handler: (...args: unknown[]) => any; opts?: object }>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  const enqueueNextTurnInjection = vi.fn(async (inj: any) => ({ enqueued: true, id: 'inj-1', sessionKey: inj.sessionKey }));
  const session = {
    workflow: { enqueueNextTurnInjection },
    state: { registerSessionExtension: vi.fn() },
  };
  return {
    api: {
      pluginConfig,
      on: vi.fn((hookName: string, handler: any, opts?: any) => hooks.set(hookName, { handler, opts })),
      registerGatewayMethod: vi.fn((method: string, handler: any) => gatewayMethods.set(method, handler)),
      session,
      enqueueNextTurnInjection,
      registerSessionExtension: session.state.registerSessionExtension,
    },
    hooks,
    gatewayMethods,
  };
}

function countCalls(spy: ReturnType<typeof vi.fn>, arg: string) {
  return spy.mock.calls.filter(c => c[0] === arg).length;
}

describe('audit refCount lifecycle balance', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    mockAuditSetMode.mockClear();
    _resetForTest();
    // Use maxTotalContinuations:2 so driveToMaxTurn pauses quickly
    mock = createMockApi({ maxTotalContinuations: 2 });
    register(mock.api as any);
    _setAuditSetModeForTest(mockAuditSetMode);
  });

  async function activateFullYolo(sessionKey: string) {
    const activate = mock.gatewayMethods.get('autopilot.activate')!;
    const start = mock.hooks.get('session_start')!.handler;
    await activate({ params: { sessionKey, }, respond: vi.fn() });
    await start({ sessionId: `sid-${sessionKey}`, sessionKey });
  }

  async function driveToComplete(sessionKey: string) {
    const finalize = mock.hooks.get('before_agent_finalize')!.handler;
    // P1-2: drive two non-completion turns so the completion signal is trusted
    // (totalContinuations must reach MIN_TURNS_BEFORE_COMPLETE before complete fires).
    for (let i = 0; i < 2; i++) {
      await finalize({ sessionId: `sid-${sessionKey}`, sessionKey, stopHookActive: false, lastAssistantMessage: 'working...' });
    }
    return finalize({ sessionId: `sid-${sessionKey}`, sessionKey, stopHookActive: false, lastAssistantMessage: '所有任务已完成' });
  }

  async function driveToMaxContinuations(sessionKey: string) {
    const finalize = mock.hooks.get('before_agent_finalize')!.handler;
    for (let i = 0; i < 10; i++) {
      const result = await finalize({ sessionId: `sid-${sessionKey}`, sessionKey, stopHookActive: false, lastAssistantMessage: 'working...' });
      if (result?.action === 'finalize') return; // paused
    }
  }

  // T-S6: complete → done should release refCount
  it('T-S6: full_yolo complete releases audit monitor refCount', async () => {
    await activateFullYolo('sess-s6');
    expect(countCalls(mockAuditSetMode, 'monitor')).toBe(1);

    await driveToComplete('sess-s6');

    // complete path must call setAuditMode('active') to balance the acquire
    expect(countCalls(mockAuditSetMode, 'active')).toBeGreaterThanOrEqual(1);
    expect(countCalls(mockAuditSetMode, 'monitor')).toBe(countCalls(mockAuditSetMode, 'active'));
  });

  // T-S7: pause must release, resume re-acquires — net balanced after stop
  it('T-S7: pause releases refCount, resume re-acquires — balanced over full cycle', async () => {
    await activateFullYolo('sess-s7');

    await driveToMaxContinuations('sess-s7');

    // After pause: active >= monitor - 1 (pause released)
    const monitorAfterPause = countCalls(mockAuditSetMode, 'monitor');
    const activeAfterPause = countCalls(mockAuditSetMode, 'active');
    expect(activeAfterPause).toBeGreaterThanOrEqual(monitorAfterPause - 1);

    // Resume
    const resume = mock.gatewayMethods.get('autopilot.resume')!;
    await resume({ params: { sessionKey: 'sess-s7' }, respond: vi.fn() });

    // Stop
    const stop = mock.gatewayMethods.get('autopilot.stop')!;
    await stop({ params: { sessionKey: 'sess-s7' }, respond: vi.fn() });

    // Final: balanced
    expect(countCalls(mockAuditSetMode, 'monitor')).toBe(countCalls(mockAuditSetMode, 'active'));
  });

  // T-SPECIAL: done → re-activate must release old refCount before new acquire
  it('T-SPECIAL: re-activate from done releases old refCount first', async () => {
    await activateFullYolo('sess-sp');
    await driveToComplete('sess-sp');

    const monitorAfterFirst = countCalls(mockAuditSetMode, 'monitor');
    const activeAfterFirst = countCalls(mockAuditSetMode, 'active');

    // Re-activate from done
    await activateFullYolo('sess-sp');

    // Old done released (+active), new activate acquired (+monitor)
    expect(countCalls(mockAuditSetMode, 'active')).toBeGreaterThan(activeAfterFirst);
    expect(countCalls(mockAuditSetMode, 'monitor')).toBeGreaterThan(monitorAfterFirst);
    // Net still balanced
    expect(countCalls(mockAuditSetMode, 'monitor')).toBe(countCalls(mockAuditSetMode, 'active'));
  });

  // T-S8: cleanup with 2 full_yolo sessions must call active N times
  it('T-S8: cleanup releases ALL full_yolo session refCounts', async () => {
    await activateFullYolo('sess-s8a');
    await activateFullYolo('sess-s8b');

    const monitorCount = countCalls(mockAuditSetMode, 'monitor');
    expect(monitorCount).toBe(2);

    const cleanup = mock.gatewayMethods.get('autopilot.cleanup')!;
    await cleanup({ respond: vi.fn() });

    expect(countCalls(mockAuditSetMode, 'active')).toBe(monitorCount);
  });

  // T-S9: cleanup must NOT over-release for already-paused sessions (RES-9).
  // A paused session already released its refCount at pause time; cleanup
  // releasing it again would push the audit refCount negative.
  it('T-S9: cleanup does not over-release refCount for a paused session', async () => {
    await activateFullYolo('sess-run');    // stays running
    await activateFullYolo('sess-pause');  // driven to pause below
    await driveToMaxContinuations('sess-pause'); // pause → releases its refCount

    const monitorCount = countCalls(mockAuditSetMode, 'monitor'); // 2 acquired
    expect(monitorCount).toBe(2);

    const cleanup = mock.gatewayMethods.get('autopilot.cleanup')!;
    await cleanup({ respond: vi.fn() });

    // Only the still-running session is released by cleanup (1); the paused one
    // was already released. Net balanced: monitor(2) === active(1 pause + 1 cleanup).
    expect(countCalls(mockAuditSetMode, 'active')).toBe(monitorCount);
  });

  // ── S8: teardown paths must release audit refCount for still-running runs ──
  // session_end / session-extension cleanup / LRU eviction all deleted run state
  // WITHOUT calling setAuditMode('active'), leaking the monitor refCount and
  // potentially pinning monitor mode permanently. cleanupAll already does it
  // correctly (T-S8 above); these tests prove the other paths catch up.

  // T-S8a: session_end must release refCount for a still-running run
  it('T-S8a: session_end releases audit refCount for a running run', async () => {
    await activateFullYolo('sess-end');

    expect(countCalls(mockAuditSetMode, 'monitor')).toBe(1);
    expect(countCalls(mockAuditSetMode, 'active')).toBe(0);

    const sessionEnd = mock.hooks.get('session_end')!.handler;
    sessionEnd({ sessionId: 'sid-sess-end', sessionKey: 'sess-end' });

    expect(countCalls(mockAuditSetMode, 'active')).toBe(1);
    expect(countCalls(mockAuditSetMode, 'monitor')).toBe(countCalls(mockAuditSetMode, 'active'));
  });

  // T-S8b: session_end must NOT over-release for an already-paused run
  it('T-S8b: session_end does not over-release for a paused run', async () => {
    await activateFullYolo('sess-end2');
    await driveToMaxContinuations('sess-end2'); // pause → released

    const activeBefore = countCalls(mockAuditSetMode, 'active'); // 1 (from pause)

    const sessionEnd = mock.hooks.get('session_end')!.handler;
    sessionEnd({ sessionId: 'sid-sess-end2', sessionKey: 'sess-end2' });

    // No additional active call — the run was already released at pause.
    expect(countCalls(mockAuditSetMode, 'active')).toBe(activeBefore);
  });

  // T-S8d: session-extension cleanup must release refCount for a running run.
  // The cleanup callback is registered via registerSessionExtension at register()
  // time; extract it from the mock and invoke it directly.
  it('T-S8d: session-extension cleanup releases audit refCount for a running run', async () => {
    await activateFullYolo('sess-ext');

    expect(countCalls(mockAuditSetMode, 'monitor')).toBe(1);
    const activeBefore = countCalls(mockAuditSetMode, 'active');

    // The registerSessionExtension mock captured the extension object.
    const extCall = (mock.api.registerSessionExtension as ReturnType<typeof vi.fn>).mock.calls[0][0];
    extCall.cleanup({ sessionKey: 'sess-ext' });

    expect(countCalls(mockAuditSetMode, 'active')).toBe(activeBefore + 1);
  });

  // T-S8c: LRU eviction must release refCount for an evicted running run.
  // MAX_RUN_STATES is 50; activating 51 sessions triggers one eviction.
  // Uses a dedicated mock with maxConcurrentAutopilot raised above 51 so every
  // activate succeeds (the default cap of 5 would reject beyond the 5th).
  it('T-S8c: LRU eviction releases audit refCount for the evicted run', async () => {
    const manyMock = createMockApi({ maxTotalContinuations: 2, maxConcurrentAutopilot: 100 });
    mockAuditSetMode.mockClear();
    _resetForTest();
    register(manyMock.api as any);
    _setAuditSetModeForTest(mockAuditSetMode);

    for (let i = 0; i < 51; i++) {
      const activate = manyMock.gatewayMethods.get('autopilot.activate')!;
      const start = manyMock.hooks.get('session_start')!.handler;
      await activate({ params: { sessionKey: `sess-evict-${i}` }, respond: vi.fn() });
      await start({ sessionId: `sid-evict-${i}`, sessionKey: `sess-evict-${i}` });
    }

    const monitorCount = countCalls(mockAuditSetMode, 'monitor');
    expect(monitorCount).toBe(51);
    // The oldest (sess-evict-0) was evicted → exactly 1 release from the eviction.
    expect(countCalls(mockAuditSetMode, 'active')).toBe(1);
  });
});
