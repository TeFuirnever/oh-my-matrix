/**
 * E2E: E6 stall inflight guard (dir-1) + productivity/no-progress detection (dir-2).
 * Real 60s patrol under fake timers. No direct reducer calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { register, _resetForTest } from '../../index';

function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  const session = {
    workflow: { enqueueNextTurnInjection: vi.fn(async () => ({ enqueued: true })) },
    state: { registerSessionExtension: vi.fn() },
  };
  return {
    api: {
      pluginConfig: {}, session,
      on: vi.fn((h: string, fn: (...a: unknown[]) => unknown) => { hooks.set(h, fn); }),
      registerGatewayMethod: vi.fn((m: string, fn: any) => { gatewayMethods.set(m, fn); }),
    } as any,
    hooks, gatewayMethods,
  };
}

async function activate(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  await mock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey }, respond: vi.fn() });
  await mock.hooks.get('session_start')!({ sessionId: `sid-${sessionKey}`, sessionKey });
  mock.hooks.get('agent_turn_prepare')!({ prompt: 'goal' }, { sessionKey });
}

async function projectionFor(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const respond = vi.fn();
  await mock.gatewayMethods.get('autopilot.status')!({ params: { sessionKey }, respond });
  return respond.mock.calls[0][1]?.projection;
}

/** Drive one revise turn with NO write/exec tool activity (pure analysis). */
async function driveIdleTurn(mock: ReturnType<typeof createMockApi>, sessionKey: string, sessionId: string) {
  const finalize = mock.hooks.get('before_agent_finalize')!;
  await finalize({ sessionId, sessionKey, stopHookActive: false, lastAssistantMessage: 'reading the code...' });
  await mock.hooks.get('agent_end')!({ sessionId, sessionKey, success: true });
}

describe('E2E: E6 stall inflight guard + no-progress detection', () => {
  let mock: ReturnType<typeof createMockApi>;
  beforeEach(() => { vi.useFakeTimers(); _resetForTest(); });
  afterEach(() => vi.useRealTimers());

  it('dir-1: a tool in flight does NOT false-stall at stallTimeout (uses the 30min cap)', async () => {
    mock = createMockApi();
    register(mock.api);
    await activate(mock, 'sess-inflight');

    // Dispatch a tool (before_tool_call) → marks in-flight. The default
    // stallTimeout is 300s; without the guard the run would stall at the 360s
    // tick. With the guard, the 30min inflight cap applies → not stalled.
    mock.hooks.get('before_tool_call')!({ toolName: 'read_file', params: { file_path: 'a.ts' } }, { sessionKey: 'sess-inflight' });

    vi.advanceTimersByTime(360_000); // past stallTimeout, well under 30min
    const proj = await projectionFor(mock, 'sess-inflight');
    expect(proj.status).toBe('running');
    expect(proj.orchestrationState).toBe('running'); // NOT stalled (no retry_queued)
  });

  it('dir-1: baseline — without an in-flight tool, the same elapsed time DOES stall', async () => {
    mock = createMockApi();
    register(mock.api);
    await activate(mock, 'sess-baseline');
    // No tool dispatched (no before_tool_call) → no in-flight marker.
    vi.advanceTimersByTime(360_000);
    const proj = await projectionFor(mock, 'sess-baseline');
    expect(proj.orchestrationState).toBe('retry_queued'); // stalled
  });

  it('dir-1: in-flight marker is cleared when a turn ends WITHOUT after_tool_call (专项 · no dangling)', async () => {
    // Ticket AC: inFlightToolStartedAt must be cleared on turn-end/crash so a
    // dangling field can't permanently relax stall detection. Simulate a tool
    // dispatched then the turn ending mid-tool (agent_end with NO after_tool_call).
    mock = createMockApi();
    register(mock.api);
    await activate(mock, 'sess-dangle');

    // Dispatch a tool → marker set.
    mock.hooks.get('before_tool_call')!({ toolName: 'read_file', params: {} }, { sessionKey: 'sess-dangle' });
    expect((await projectionFor(mock, 'sess-dangle')).inFlightToolStartedAt).toBeTypeOf('number');

    // Turn ends WITHOUT after_tool_call (crash / model finalized mid-tool) → cleared.
    await mock.hooks.get('agent_end')!({ sessionId: 'sid-dangle', sessionKey: 'sess-dangle', success: true });
    expect((await projectionFor(mock, 'sess-dangle')).inFlightToolStartedAt).toBeUndefined();
  });

  it('dir-2: N consecutive no-output turns → pause(no_progress)', async () => {
    mock = createMockApi();
    register(mock.api);
    await activate(mock, 'sess-noprog');

    const sk = 'sess-noprog';
    const sid = 'sid-noprog';
    // Drive 3 idle (read-only) revise turns — no write/exec → ledger stays empty.
    for (let i = 0; i < 3; i++) {
      await driveIdleTurn(mock, sk, sid);
    }
    expect((await projectionFor(mock, sk)).totalContinuations).toBe(3);

    // Patrol tick: 3 turns since last progress (0) ≥ threshold 3 → pause.
    vi.advanceTimersByTime(60_000);
    const proj = await projectionFor(mock, sk);
    expect(proj.status).toBe('paused');
    expect(proj.pauseReason).toBe('no_progress');
    expect(proj.blockedReason).toBe('no_progress');
  });

  it('dir-2: a turn WITH output resets the no-progress count (no premature pause)', async () => {
    mock = createMockApi();
    register(mock.api);
    await activate(mock, 'sess-prog');

    const sk = 'sess-prog';
    const sid = 'sid-prog';
    // 2 idle turns, then 1 productive turn (write tool), then 1 more idle.
    await driveIdleTurn(mock, sk, sid);
    await driveIdleTurn(mock, sk, sid);
    // productive turn: a write tool fires during the turn.
    const finalize = mock.hooks.get('before_agent_finalize')!;
    mock.hooks.get('after_tool_call')!({ toolName: 'write_file', params: { file_path: 'src/x.ts' } }, { sessionKey: sk });
    await finalize({ sessionId: sid, sessionKey: sk, stopHookActive: false, lastAssistantMessage: 'wrote x.ts' });
    await mock.hooks.get('agent_end')!({ sessionId: sid, sessionKey: sk, success: true });
    await driveIdleTurn(mock, sk, sid);

    vi.advanceTimersByTime(60_000);
    const proj = await projectionFor(mock, sk);
    // totalContinuations=4, lastProgressTurn=3 → delta=1 < 3 → NOT paused.
    expect(proj.status).toBe('running');
    expect(proj.pauseReason).not.toBe('no_progress');
  });
});
