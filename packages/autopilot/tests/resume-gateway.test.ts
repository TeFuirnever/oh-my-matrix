import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { register, _resetForTest } from '../index';

// T03 fix regression tests (autopilot.resume gateway).
// Review findings (2026-08-09): the gateway force-resumed terminal runs
// (non-resumable blockedReason) via the legacy resume() setter, and threw on
// the legitimate resumable path. Fix: stop when the reducer no-ops; reducer is
// the transition's sole writer.
function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  const injections: any[] = [];
  let sessionExtension: any = null;

  const enqueueNextTurnInjection = vi.fn(async (injection: any) => {
    injections.push(injection);
    return { enqueued: true, id: `inj-${injections.length}`, sessionKey: injection.sessionKey };
  });
  const registerSessionExtension = vi.fn((ext: any) => {
    sessionExtension = ext;
  });

  return {
    api: {
      pluginConfig: {} as Record<string, unknown>,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => {
        hooks.set(hookName, handler);
        void opts;
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      session: {
        workflow: { enqueueNextTurnInjection } as { enqueueNextTurnInjection?: typeof enqueueNextTurnInjection },
        state: { registerSessionExtension },
      },
    },
    hooks,
    gatewayMethods,
    getInjections: () => injections,
    getSessionExtension: () => sessionExtension,
  };
}

describe('autopilot.resume gateway (T03 fix)', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    vi.useRealTimers();
    mock = createMockApi();
    register(mock.api as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects resume of a non-resumable blocked run (loop_breaker) — no force-resume, state unchanged', async () => {
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    await activateHandler({ params: { sessionKey: 'sess-1' }, respond: vi.fn() });

    // Fire before_agent_finalize first so the agent_end canary passes; otherwise
    // agent_end takes the degraded-fallback path and skips the circuit-breaker pause.
    const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
    await finalizeHandler({ sessionId: 'sid-1', sessionKey: 'sess-1', stopHookActive: false, lastAssistantMessage: 'working...' });

    // Drive the run to blocked+loop_breaker_triggered (non-resumable, derives 'paused').
    const agentEndHandler = mock.hooks.get('agent_end')!;
    await agentEndHandler({ sessionId: 'sid-1', sessionKey: 'sess-1', success: false, error: 'circuit breaker' });

    const resumeHandler = mock.gatewayMethods.get('autopilot.resume')!;
    const respond = vi.fn();
    await resumeHandler({ params: { sessionKey: 'sess-1' }, respond });

    expect(respond.mock.calls[0][0]).toBe(false);
    expect(respond.mock.calls[0][2]?.code).toBe('INVALID_REQUEST');
    expect(respond.mock.calls[0][2]?.message).toContain('not recoverable');

    // State must NOT have been resurrected.
    const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
    const respondStatus = vi.fn();
    await statusHandler({ params: { sessionKey: 'sess-1' }, respond: respondStatus });
    const projection = respondStatus.mock.calls[0][1]?.projection;
    expect(projection.status).toBe('paused');
    expect(projection.blockedReason).toBe('loop_breaker_triggered');
    expect(projection.enabled).toBe(false);
  });

  it('resumes a resumable blocked run (no_progress) — respond true + continuation injection', async () => {
    // Patrol is a setInterval created at register(); fake timers must be active first.
    vi.useFakeTimers();
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);

    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    await activateHandler({ params: { sessionKey: 'sess-1' }, respond: vi.fn() });

    // Three no-activity turns: ledger stays empty, totalContinuations grows → no_progress.
    const agentEndHandler = mock.hooks.get('agent_end')!;
    const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
    for (let i = 0; i < 3; i++) {
      await finalizeHandler({ sessionId: 'sid-1', sessionKey: 'sess-1', stopHookActive: false, lastAssistantMessage: 'working...' });
      await agentEndHandler({ sessionId: 'sid-1', sessionKey: 'sess-1', success: true });
    }

    // Patrol tick → pause(no_progress) → blocked+no_progress (resumable, 'paused').
    vi.advanceTimersByTime(60_000);

    const resumeHandler = mock.gatewayMethods.get('autopilot.resume')!;
    const respond = vi.fn();
    await resumeHandler({ params: { sessionKey: 'sess-1' }, respond });

    expect(respond.mock.calls[0][0]).toBe(true);
    // kickResumedTurn must have enqueued a continuation injection.
    expect(mock.getInjections().length).toBeGreaterThan(0);

    const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
    const respondStatus = vi.fn();
    await statusHandler({ params: { sessionKey: 'sess-1' }, respond: respondStatus });
    const projection = respondStatus.mock.calls[0][1]?.projection;
    expect(projection.status).toBe('running');
    expect(projection.enabled).toBe(true);
  });
});
