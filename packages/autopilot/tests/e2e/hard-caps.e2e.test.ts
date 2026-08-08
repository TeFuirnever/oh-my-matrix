/**
 * E2E: E2 hard caps (wall-clock) via the REAL 60s patrol under fake timers.
 *
 * Proves the load-bearing integration the reducer test can't:
 *   1. TENSION 3 — a cap firing while the run is in retry_queued TERMINATES it
 *      (pause_requested would no-op here; the patrol dispatches hard_stop_requested).
 *   2. Controlled winddown — a producing run gets ONE summarize injection before
 *      the cap terminates it on the next tick (not a silent stop).
 *
 * Everything runs through register() + the registered hooks + the real
 * setInterval sweeper. No direct reducer calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { register, _resetForTest } from '../../index';

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  const enqueueNextTurnInjection = vi.fn(async (injection: any) => ({
    enqueued: true, id: `inj-${injection.sessionKey}`, sessionKey: injection.sessionKey,
  }));
  const session = {
    workflow: { enqueueNextTurnInjection } as { enqueueNextTurnInjection?: typeof enqueueNextTurnInjection },
    state: { registerSessionExtension: vi.fn() },
  };
  return {
    api: {
      pluginConfig, session, enqueueNextTurnInjection,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => { hooks.set(hookName, handler); }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => { gatewayMethods.set(method, handler); }),
    },
    hooks, gatewayMethods, enqueueNextTurnInjection,
  };
}

async function activate(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const handler = mock.gatewayMethods.get('autopilot.activate')!;
  const respond = vi.fn();
  await handler({ params: { sessionKey }, respond });
  return respond.mock.calls[0];
}

async function projectionFor(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const status = mock.gatewayMethods.get('autopilot.status')!;
  const respond = vi.fn();
  await status({ params: { sessionKey }, respond });
  return respond.mock.calls[0][1]?.projection;
}

/** claimed → running via the registered agent_turn_prepare hook (first turn). */
async function driveToRunningFirstTurn(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const sessionStart = mock.hooks.get('session_start')!;
  await sessionStart({ sessionId: `sid-${sessionKey}`, sessionKey });
  mock.hooks.get('agent_turn_prepare')!({ prompt: 'goal' }, { sessionKey });
}

describe('E2E: E2 hard caps (wall-clock) via the 60s patrol', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetForTest();
  });
  afterEach(() => vi.useRealTimers());

  it('TENSION 3: a stalled (retry_queued) run is terminated by the cap, not swallowed', async () => {
    // A run that stalls cycles running→retry_queued→claimed under the patrol.
    // Once the wall-clock cap is exceeded the patrol MUST terminate it — whether
    // it catches the run in retry_queued (hard_stop bypasses pause_requested's
    // no-op) or in a producing state (armed→terminate next tick). Either way the
    // run ends blocked with max_duration_reached; it cannot loop forever burning
    // a budget it has already spent. (The retry_queued-specific reducer path is
    // proven definitively in orchestrator.test.ts; this proves the patrol wiring.)
    mock = createMockApi({ maxDurationMs: 400_000 });
    register(mock.api as any);

    await activate(mock, 'sess-cap');
    await driveToRunningFirstTurn(mock, 'sess-cap');
    expect((await projectionFor(mock, 'sess-cap')).status).toBe('running');

    // Drive well past the cap (400s) so every cap-hit branch has had time to fire
    // across multiple 60s ticks, regardless of where the stall cycle leaves the
    // run on any single tick.
    vi.advanceTimersByTime(400_000 + 180_000);

    const proj = await projectionFor(mock, 'sess-cap');
    expect(proj.status).toBe('paused'); // blocked (non-user_stopped) → paused
    expect(proj.orchestrationState).toBe('blocked');
    expect(proj.pauseReason).toBe('max_duration_reached');
    expect(proj.blockedReason).toBe('max_duration_reached');
    expect(proj.enabled).toBe(false);
  });

  it('controlled winddown: a producing run gets one summarize injection, then stops', async () => {
    // maxDurationMs 120s < stallTimeout 300s, so the cap fires while the run is
    // still actively 'running' (no stall). Producing runs get ONE winddown turn;
    // the run terminates on the NEXT tick.
    mock = createMockApi({ maxDurationMs: 120_000 });
    register(mock.api as any);

    await activate(mock, 'sess-wind');
    await driveToRunningFirstTurn(mock, 'sess-wind');

    // First cap tick: inject winddown, do NOT terminate yet.
    vi.advanceTimersByTime(120_000);
    const afterCapHit = await projectionFor(mock, 'sess-wind');
    expect(afterCapHit.status).toBe('running'); // still running — grace turn
    const winddownCalls = mock.enqueueNextTurnInjection.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('limit reached'),
    );
    expect(winddownCalls.length).toBe(1);
    expect(winddownCalls[0][0].text).toContain('Wrap up NOW');

    // Second tick: grace elapsed → terminate.
    vi.advanceTimersByTime(60_000);
    const proj = await projectionFor(mock, 'sess-wind');
    expect(proj.status).toBe('paused');
    expect(proj.pauseReason).toBe('max_duration_reached');
    // Winddown was injected exactly once (not re-injected each tick).
    const totalWinddown = mock.enqueueNextTurnInjection.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('limit reached'),
    );
    expect(totalWinddown.length).toBe(1);
  });
});
