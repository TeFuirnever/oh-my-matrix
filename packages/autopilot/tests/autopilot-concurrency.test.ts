import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register, _resetForTest } from '../index';

function createMockApi(pluginConfig?: Record<string, unknown>) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => unknown>();

  return {
    api: {
      pluginConfig,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        hooks.set(hookName, handler);
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      registerSessionExtension: vi.fn(),
      enqueueNextTurnInjection: vi.fn(),
    },
    hooks,
    gatewayMethods,
  };
}

describe('autopilot concurrency control', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api);
  });

  async function callActivate(sessionKey: string) {
    const respond = vi.fn();
    await mock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey }, respond });
    return respond;
  }

  async function callStop(sessionKey: string) {
    const respond = vi.fn();
    await mock.gatewayMethods.get('autopilot.stop')!({ params: { sessionKey }, respond });
    return respond;
  }

  // Test 1: activate with 0 running sessions → { ok: true }
  it('allows activate when no sessions are running', async () => {
    const respond = await callActivate('session-1');
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(respond.mock.calls[0][1]).toMatchObject({ ok: true });
  });

  // Test 2: activate with 4 running sessions (maxConcurrent=5) → { ok: true }
  it('allows activate when 4 sessions are running (default limit=5)', async () => {
    for (let i = 1; i <= 4; i++) await callActivate(`session-${i}`);
    const respond = await callActivate('session-5');
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(respond.mock.calls[0][1]).toMatchObject({ ok: true });
  });

  // Test 3: activate with 5 running sessions (maxConcurrent=5) → { ok: false, error: 'max_concurrent_reached' }
  it('rejects activate when 5 sessions are already running (default limit=5)', async () => {
    for (let i = 1; i <= 5; i++) await callActivate(`session-${i}`);
    const respond = await callActivate('session-6');
    expect(respond.mock.calls[0][0]).toBe(false);
    expect(respond.mock.calls[0][2]).toMatchObject({ message: expect.stringContaining('max_concurrent_reached') });
  });

  // Test 4: activate after stop reduces count, next activate succeeds
  it('allows activate after a running session is stopped', async () => {
    for (let i = 1; i <= 5; i++) await callActivate(`session-${i}`);
    // All 5 slots full — next should fail
    const respondFail = await callActivate('session-6');
    expect(respondFail.mock.calls[0][0]).toBe(false);
    // Stop one session to free a slot
    await callStop('session-1');
    // Now only 4 running → activate should succeed
    const respondOk = await callActivate('session-6');
    expect(respondOk.mock.calls[0][0]).toBe(true);
    expect(respondOk.mock.calls[0][1]).toMatchObject({ ok: true });
  });

  // Test 5: maxConcurrentAutopilot defaults to 5 in DEFAULT_CONFIG
  it('DEFAULT_CONFIG includes maxConcurrentAutopilot: 5', async () => {
    const { DEFAULT_CONFIG } = await import('../src/types');
    expect((DEFAULT_CONFIG as any).maxConcurrentAutopilot).toBe(5);
  });

  // Test 6: config value of 3 enforces limit at 3 concurrent sessions
  it('enforces custom maxConcurrentAutopilot of 3', async () => {
    _resetForTest();
    const customMock = createMockApi({ maxConcurrentAutopilot: 3 });
    register(customMock.api);
    const customActivate = async (key: string) => {
      const respond = vi.fn();
      await customMock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: key }, respond });
      return respond;
    };

    expect((await customActivate('session-1')).mock.calls[0][0]).toBe(true);
    expect((await customActivate('session-2')).mock.calls[0][0]).toBe(true);
    expect((await customActivate('session-3')).mock.calls[0][0]).toBe(true);
    // 4th exceeds limit of 3
    expect((await customActivate('session-4')).mock.calls[0][0]).toBe(false);
  });

  // Test 7: idle/paused/done sessions do NOT count toward concurrency (only 'running')
  it('does not count idle sessions (stopped) toward the concurrency limit', async () => {
    // Use a custom limit of 2 to keep the test small
    _resetForTest();
    const limitedMock = createMockApi({ maxConcurrentAutopilot: 2 });
    register(limitedMock.api);
    const limitedActivate = async (key: string) => {
      const respond = vi.fn();
      await limitedMock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: key }, respond });
      return respond;
    };
    const limitedStop = async (key: string) => {
      const respond = vi.fn();
      await limitedMock.gatewayMethods.get('autopilot.stop')!({ params: { sessionKey: key }, respond });
      return respond;
    };

    // Fill up 2 slots
    expect((await limitedActivate('session-1')).mock.calls[0][0]).toBe(true);
    expect((await limitedActivate('session-2')).mock.calls[0][0]).toBe(true);
    // Both slots taken — third should be rejected
    expect((await limitedActivate('session-3')).mock.calls[0][0]).toBe(false);

    // Stop session-1 → state becomes idle (still present in stateByRun map)
    await limitedStop('session-1');

    // session-1 is now idle, not running — should NOT count toward limit
    // Only session-2 is running (1 < 2), so session-3 activate must succeed
    expect((await limitedActivate('session-3')).mock.calls[0][0]).toBe(true);
  });
});
