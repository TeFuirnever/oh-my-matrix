import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { register, _resetForTest } from '../index';

// Hoist mock so validation commands can be configured per-test
vi.mock('../src/workflow-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow-config')>();
  return {
    ...actual,
    loadWorkflowConfig: vi.fn(() => ({
      config: { ...actual.DEFAULT_WORKFLOW_CONFIG },
      warnings: [],
    })),
  };
});

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

describe('Evidence Gate wiring', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as unknown as Parameters<typeof register>[0]);
  });

  afterEach(() => {
    _resetForTest();
  });

  describe('complete case with no validation commands', () => {
    async function activateAndComplete(sessionKey: string) {
      const activateRespond = vi.fn();
      await mock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey }, respond: activateRespond });

      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-1', sessionKey });

      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      // P1-2: completion requires totalContinuations >= MIN_TURNS_BEFORE_COMPLETE.
      // Drive two non-completion turns first so the completion signal is trusted.
      for (let i = 0; i < 2; i++) {
        await finalizeHandler({
          sessionId: 'sid-1',
          sessionKey,
          stopHookActive: false,
          lastAssistantMessage: 'still working on the task...',
        });
      }
      // Completion signal triggers decideContinuation → 'complete'
      return finalizeHandler({
        sessionId: 'sid-1',
        sessionKey,
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成，代码通过了全部测试。',
      });
    }

    it('projection.evidenceStatus === "skipped" after complete (no validation commands)', async () => {
      await activateAndComplete('sess-ev1');

      const respond = vi.fn();
      await mock.gatewayMethods.get('autopilot.status')!({ params: { sessionKey: 'sess-ev1' }, respond });
      const projection = respond.mock.calls[0][1]?.projection;

      expect(projection.evidenceStatus).toBe('skipped');
    });

    it('projection.status === "done" after complete (Evidence Gate does not block completion)', async () => {
      await activateAndComplete('sess-ev2');

      const respond = vi.fn();
      await mock.gatewayMethods.get('autopilot.status')!({ params: { sessionKey: 'sess-ev2' }, respond });
      const projection = respond.mock.calls[0][1]?.projection;

      expect(projection.status).toBe('done');
    });
  });

  describe('complete case WITH validation commands (M5.3)', () => {
    it.skipIf(process.platform === 'win32')('executes commands, marks evidenceStatus=passed and projection.status=done when commands succeed', async () => {
      const { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } =
        await import('../src/workflow-config');
      vi.mocked(loadWorkflowConfig).mockReturnValueOnce({
        config: {
          ...DEFAULT_WORKFLOW_CONFIG,
          validation: {
            commands: [{ id: 'echo-test', command: 'echo ok', timeoutMs: 5000, required: true }],
            failOnOptional: false,
          },
        },
        warnings: [],
      });

      _resetForTest();
      const mockWithCmd = createMockApi();
      register(mockWithCmd.api as unknown as Parameters<typeof register>[0]);

      const activateRespond = vi.fn();
      await mockWithCmd.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: 'sess-ev-cmd', trustWorkspace: true }, respond: activateRespond });
      await mockWithCmd.hooks.get('session_start')!({ sessionId: 'sid-cmd', sessionKey: 'sess-ev-cmd' });

      // P1-2: drive two non-completion turns so the completion signal is trusted.
      const finalizeCmd = mockWithCmd.hooks.get('before_agent_finalize')!;
      for (let i = 0; i < 2; i++) {
        await finalizeCmd({ sessionId: 'sid-cmd', sessionKey: 'sess-ev-cmd', stopHookActive: false, lastAssistantMessage: 'still working...' });
      }
      await finalizeCmd({
        sessionId: 'sid-cmd',
        sessionKey: 'sess-ev-cmd',
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成，代码通过了全部测试。',
      });

      const statusRespond = vi.fn();
      await mockWithCmd.gatewayMethods.get('autopilot.status')!({ params: { sessionKey: 'sess-ev-cmd' }, respond: statusRespond });
      const projection = statusRespond.mock.calls[0][1]?.projection;

      // Command actually ran → evidenceStatus should be 'passed', not 'skipped' or 'failed'
      expect(projection.evidenceStatus).toBe('passed');
      // Run was marked done because evidence passed
      expect(projection.status).toBe('done');
      // Command results are present in the projection
      expect(projection.lastEvidenceCommands).toHaveLength(1);
      expect(projection.lastEvidenceCommands[0].id).toBe('echo-test');
      expect(projection.lastEvidenceCommands[0].status).toBe('passed');
    }, 10000);

    it.skipIf(process.platform === 'win32')('marks evidenceStatus=failed when a required command exits non-zero', async () => {
      const { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } =
        await import('../src/workflow-config');
      vi.mocked(loadWorkflowConfig).mockReturnValueOnce({
        config: {
          ...DEFAULT_WORKFLOW_CONFIG,
          validation: {
            commands: [{ id: 'fail-cmd', command: 'false', timeoutMs: 5000, required: true }],
            failOnOptional: false,
          },
        },
        warnings: [],
      });

      _resetForTest();
      const mockFail = createMockApi();
      register(mockFail.api as unknown as Parameters<typeof register>[0]);

      const activateRespond = vi.fn();
      await mockFail.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: 'sess-ev-fail', trustWorkspace: true }, respond: activateRespond });
      await mockFail.hooks.get('session_start')!({ sessionId: 'sid-fail', sessionKey: 'sess-ev-fail' });

      // P1-2: drive two non-completion turns so the completion signal is trusted.
      const finalizeFail = mockFail.hooks.get('before_agent_finalize')!;
      for (let i = 0; i < 2; i++) {
        await finalizeFail({ sessionId: 'sid-fail', sessionKey: 'sess-ev-fail', stopHookActive: false, lastAssistantMessage: 'still working...' });
      }
      await finalizeFail({
        sessionId: 'sid-fail',
        sessionKey: 'sess-ev-fail',
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成，代码通过了全部测试。',
      });

      const statusRespond = vi.fn();
      await mockFail.gatewayMethods.get('autopilot.status')!({ params: { sessionKey: 'sess-ev-fail' }, respond: statusRespond });
      const projection = statusRespond.mock.calls[0][1]?.projection;

      // Command ran and failed → evidence failed
      expect(projection.evidenceStatus).toBe('failed');
      expect(projection.lastEvidenceCommands).toHaveLength(1);
      expect(projection.lastEvidenceCommands[0].status).toBe('failed');
    }, 10000);
  });
});
