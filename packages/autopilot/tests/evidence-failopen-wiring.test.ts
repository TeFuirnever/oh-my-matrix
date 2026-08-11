import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register, _resetForTest } from '../index';

// E4/E7 fail-closed wiring regression: an evaluation error (runner throws)
// must become skipped/not_executed → blocked evidence_missing, never done.
vi.mock('../src/workflow-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow-config')>();
  return { ...actual, loadWorkflowConfig: vi.fn() };
});
vi.mock('../src/command-runner', () => ({
  runValidationCommands: vi.fn(async () => {
    throw new Error('boom');
  }),
}));

function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => unknown>();
  let sessionExtension: any = null;
  const injections: any[] = [];

  return {
    api: {
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        hooks.set(hookName, handler);
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      registerSessionExtension: vi.fn((ext: any) => {
        sessionExtension = ext;
      }),
      enqueueNextTurnInjection: vi.fn(async (injection: any) => {
        injections.push(injection);
        return { enqueued: true, id: `inj-${injections.length}`, sessionKey: injection.sessionKey };
      }),
    },
    hooks,
    gatewayMethods,
    getSessionExtension: () => sessionExtension,
    getInjections: () => injections,
  };
}

describe('Evidence Gate fail-open wiring (E4/E7 fail-closed)', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('evaluation error → skipped/not_executed → blocked evidence_missing (never done)', async () => {
    const { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } = await import('../src/workflow-config');
    vi.mocked(loadWorkflowConfig).mockReturnValueOnce({
      config: {
        ...DEFAULT_WORKFLOW_CONFIG,
        validation: {
          commands: [{ id: 'boom-test', command: 'boom', timeoutMs: 5000, required: true }],
          failOnOptional: false,
        },
      },
      warnings: [],
    });

    const mock = createMockApi();
    register(mock.api as unknown as Parameters<typeof register>[0]);

    await mock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: 'sess-fo', trustWorkspace: true }, respond: vi.fn() });
    await mock.hooks.get('session_start')!({ sessionId: 'sid-fo', sessionKey: 'sess-fo' });
    mock.hooks.get('agent_turn_prepare')!({ prompt: 'task' }, { sessionKey: 'sess-fo' });

    const finalize = mock.hooks.get('before_agent_finalize')!;
    for (let i = 0; i < 3; i++) {
      await finalize({ sessionId: 'sid-fo', sessionKey: 'sess-fo', stopHookActive: false, lastAssistantMessage: 'still working...' });
    }
    await finalize({ sessionId: 'sid-fo', sessionKey: 'sess-fo', stopHookActive: false, lastAssistantMessage: '所有任务已完成' });

    const respond = vi.fn();
    await mock.gatewayMethods.get('autopilot.status')!({ params: { sessionKey: 'sess-fo' }, respond });
    const projection = respond.mock.calls[0][1]?.projection;

    // Fail-closed: the run must NOT reach done — it blocks on evidence_missing (resumable).
    expect(projection.evidenceStatus).toBe('skipped');
    expect(projection.blockedReason).toBe('evidence_missing');
    // Blocked ≠ completion: completionUnverified only surfaces on 'done' runs
    // (V9) — a paused run projects undefined, never false or true.
    expect(projection.completionUnverified).toBeUndefined();
    expect(projection.status).toBe('paused');
  });
});
