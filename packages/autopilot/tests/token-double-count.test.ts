import { describe, it, expect, beforeEach, vi } from 'vitest';
import { register, _resetForTest } from '../index';
import type { GatewayCtx } from '../src/types';

function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const gatewayMethods = new Map<string, (ctx: GatewayCtx) => void | Promise<void>>();
  let sessionExtension: any = null;

  const enqueueNextTurnInjection = async (injection: any) => ({
    enqueued: true,
    id: `inj-1`,
    sessionKey: injection.sessionKey,
  });
  const registerSessionExtension = (ext: any) => {
    sessionExtension = ext;
  };

  return {
    api: {
      on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
        hooks.set(hookName, handler);
      },
      registerGatewayMethod: (method: string, handler: (ctx: GatewayCtx) => void | Promise<void>) => {
        gatewayMethods.set(method, handler);
      },
      session: {
        workflow: { enqueueNextTurnInjection },
        state: { registerSessionExtension },
      },
    },
    hooks,
    gatewayMethods,
    getSessionExtension: () => sessionExtension,
  };
}

describe('token double-count regression', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
  });

  it('inputTokensUsed equals single delta (not 2x) after one llm_output event', async () => {
    // Activate autopilot for session
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    await activateHandler({ params: { sessionKey: 'sess-token-test' }, respond: vi.fn() });

    // Register session mapping
    const sessionStartHandler = mock.hooks.get('session_start')!;
    await sessionStartHandler({ sessionId: 'sid-token-test', sessionKey: 'sess-token-test' });

    // Fire one llm_output event with input=30, output=70, total=100
    const llmOutputHandler = mock.hooks.get('llm_output')!;
    await llmOutputHandler(
      { usage: { total: 100, input: 30, output: 70 } },
      { sessionKey: 'sess-token-test' }
    );

    // Read back via session extension projection
    const ext = mock.getSessionExtension();
    const projection = ext.project({ sessionKey: 'sess-token-test' });

    // inputTokensUsed must equal 30, not 60 (2x would indicate double-count bug)
    expect(projection.inputTokensUsed).toBe(30);
    expect(projection.outputTokensUsed).toBe(70);
  });

  it('totalTokensUsed is also 100 after one llm_output event', async () => {
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    await activateHandler({ params: { sessionKey: 'sess-total-test' }, respond: vi.fn() });

    const sessionStartHandler = mock.hooks.get('session_start')!;
    await sessionStartHandler({ sessionId: 'sid-total-test', sessionKey: 'sess-total-test' });

    const llmOutputHandler = mock.hooks.get('llm_output')!;
    await llmOutputHandler(
      { usage: { total: 100, input: 30, output: 70 } },
      { sessionKey: 'sess-total-test' }
    );

    const ext = mock.getSessionExtension();
    const projection = ext.project({ sessionKey: 'sess-total-test' });

    expect(projection.totalTokensUsed).toBe(100);
  });
});
