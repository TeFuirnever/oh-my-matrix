/**
 * TDD: retry_due auto-dispatch in stall interval
 *
 * Verifies that when a run is in `retry_queued` and its backoff period has
 * expired, the stall interval callback transitions it to `claimed` via the
 * orchestratorReducer retry_due event.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  _resetForTest,
  _triggerRetryCheckForTest,
} from '../index';

function makeApi() {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  return {
    api: {
      on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
        hooks.set(hookName, handler);
      },
      registerGatewayMethod: () => {},
      registerSessionExtension: () => {},
      enqueueNextTurnInjection: async () => ({ enqueued: true, id: 'inj-1', sessionKey: 'test' }),
    },
    hooks,
  };
}

/** Register and fire session_start to create a run entry, return runId. */
function setupSession(sessionKey: string, sessionId: string) {
  const mock = makeApi();
  _resetForTest();
  register(mock.api as any);
  const sessionStartHook = mock.hooks.get('session_start') as (ctx: unknown) => void;
  sessionStartHook({ sessionKey, sessionId });
  return mock;
}

describe('retry_due auto-dispatch in stall interval', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('transitions retry_queued run to claimed when backoff expires', () => {
    const now = Date.now();
    setupSession('test-session-1', 'sid-1');

    const result = _triggerRetryCheckForTest({
      sessionKey: 'test-session-1',
      orchestrationState: 'retry_queued',
      retry: { attempt: 1, nextRetryAt: now - 1000, lastError: 'stalled', recoverable: true },
    });

    expect(result).toBeDefined();
    expect(result?.orchestrationState).toBe('claimed');
  });

  it('does NOT transition retry_queued run when backoff has not expired', () => {
    const now = Date.now();
    setupSession('test-session-2', 'sid-2');

    const result = _triggerRetryCheckForTest({
      sessionKey: 'test-session-2',
      orchestrationState: 'retry_queued',
      retry: { attempt: 1, nextRetryAt: now + 30000, lastError: 'stalled', recoverable: true },
    });

    expect(result?.orchestrationState).toBe('retry_queued');
  });

  it('does NOT affect runs that are not retry_queued', () => {
    setupSession('test-session-3', 'sid-3');

    const result = _triggerRetryCheckForTest({
      sessionKey: 'test-session-3',
      orchestrationState: 'running',
      retry: undefined,
    });

    expect(result?.orchestrationState).toBe('running');
  });
});
