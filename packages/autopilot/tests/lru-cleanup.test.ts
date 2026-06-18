import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register, _resetForTest, _getInternalStateForTest } from '../index';

function createMockApi(pluginConfig?: Record<string, unknown>) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => unknown>();

  return {
    api: {
      pluginConfig: pluginConfig ?? {},
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        hooks.set(hookName, handler);
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      registerSessionExtension: vi.fn(),
      enqueueNextTurnInjection: vi.fn(async (injection: any) => ({
        enqueued: true,
        id: `inj-1`,
        sessionKey: injection.sessionKey,
      })),
    },
    hooks,
    gatewayMethods,
  };
}

describe('LRU eviction — sessionIdToKey cleanup', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    // Use maxConcurrentAutopilot=100 so all 51 activations succeed and eviction fires
    mock = createMockApi({ maxConcurrentAutopilot: 100 });
    register(mock.api);
  });

  it('sessionIdToKey.size stays <= MAX_RUN_STATES after 51 activations with session_start', async () => {
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    const sessionStartHandler = mock.hooks.get('session_start')!;

    // Create 51 sessions: register sessionId→sessionKey AND activate each one
    for (let i = 1; i <= 51; i++) {
      const sessionKey = `sess-${i}`;
      const sessionId = `sid-${i}`;

      // Fire session_start to populate sessionIdToKey
      await sessionStartHandler({ sessionId, sessionKey });

      // Activate autopilot for this session (calls setState → evictOldestRuns)
      const respond = vi.fn();
      await activateHandler({ params: { sessionKey }, respond });
      expect(respond.mock.calls[0][0]).toBe(true);
    }

    const state = _getInternalStateForTest();

    // After eviction, stateByRun should be at most MAX_RUN_STATES (50)
    expect(state.stateByRunSize).toBeLessThanOrEqual(50);

    // sessionIdToKey must also not exceed MAX_RUN_STATES — the bug is that it was never cleaned
    expect(state.sessionIdToKeySize).toBeLessThanOrEqual(50);
  });

  it('sessionIdToKey.size does not exceed stateByRun.size after 55 activations', async () => {
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    const sessionStartHandler = mock.hooks.get('session_start')!;

    for (let i = 1; i <= 55; i++) {
      const sessionKey = `sess-${i}`;
      const sessionId = `sid-${i}`;
      await sessionStartHandler({ sessionId, sessionKey });
      const respond = vi.fn();
      await activateHandler({ params: { sessionKey }, respond });
    }

    const state = _getInternalStateForTest();

    // stateByRun capped at 50
    expect(state.stateByRunSize).toBeLessThanOrEqual(50);

    // sessionIdToKey must match: evicted runs must have their sessionId entries removed too
    expect(state.sessionIdToKeySize).toBeLessThanOrEqual(state.stateByRunSize);
  });
});
