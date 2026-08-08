import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register, _resetForTest } from '../index';

function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const hookOpts = new Map<string, { priority?: number; timeoutMs?: number } | undefined>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  let sessionExtension: any = null;
  const injections: any[] = [];

  const enqueueNextTurnInjection = vi.fn(async (injection: any) => {
    injections.push(injection);
    return { enqueued: true, id: `inj-${injections.length}`, sessionKey: injection.sessionKey };
  });
  const registerSessionExtension = vi.fn((ext: any) => {
    sessionExtension = ext;
  });

  // session is a mutable ref so tests can swap workflow internals without `as any`
  const session = {
    workflow: { enqueueNextTurnInjection } as { enqueueNextTurnInjection?: typeof enqueueNextTurnInjection },
    state: { registerSessionExtension },
  };

  return {
    api: {
      pluginConfig: {} as Record<string, unknown>,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number; timeoutMs?: number }) => {
        hooks.set(hookName, handler);
        hookOpts.set(hookName, opts);
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      session,
      // keep direct references for test assertions
      enqueueNextTurnInjection,
      registerSessionExtension,
    },
    hooks,
    hookOpts,
    gatewayMethods,
    getSessionExtension: () => sessionExtension,
    getInjections: () => injections,
  };
}

/**
 * P1-2: completion requires totalContinuations >= MIN_TURNS_BEFORE_COMPLETE (2).
 * Drive two non-completion turns so a later completion signal is trusted.
 */
async function driveNonCompletionTurns(
  finalize: (...args: unknown[]) => unknown,
  sessionId: string,
  sessionKey: string,
) {
  for (let i = 0; i < 2; i++) {
    await finalize({ sessionId, sessionKey, stopHookActive: false, lastAssistantMessage: 'still working...' });
  }
}

describe('plugin-entry register()', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
  });

  describe('hook registration', () => {
    it('registers before_agent_finalize hook', () => {
      expect(mock.hooks.has('before_agent_finalize')).toBe(true);
    });

    it('registers agent_end hook', () => {
      expect(mock.hooks.has('agent_end')).toBe(true);
    });

    it('registers after_tool_call hook', () => {
      expect(mock.hooks.has('after_tool_call')).toBe(true);
    });

    it('registers before_compaction hook', () => {
      expect(mock.hooks.has('before_compaction')).toBe(true);
    });

    it('registers after_compaction hook', () => {
      expect(mock.hooks.has('after_compaction')).toBe(true);
    });

    it('registers session_start hook', () => {
      expect(mock.hooks.has('session_start')).toBe(true);
    });

    it('registers session_end hook', () => {
      expect(mock.hooks.has('session_end')).toBe(true);
    });

    it('registers agent_turn_prepare hook', () => {
      expect(mock.hooks.has('agent_turn_prepare')).toBe(true);
    });

    it('registers before_agent_run hook', () => {
      expect(mock.hooks.has('before_agent_run')).toBe(true);
    });

    it('registers before_tool_call hook', () => {
      expect(mock.hooks.has('before_tool_call')).toBe(true);
    });

    it('registers before_tool_call hook with priority 10 (T-1)', () => {
      expect(mock.hooks.has('before_tool_call')).toBe(true);
      expect(mock.hookOpts.get('before_tool_call')?.priority).toBe(10);
    });
  });

  describe('gateway methods', () => {
    it('registers autopilot.activate method', () => {
      expect(mock.gatewayMethods.has('autopilot.activate')).toBe(true);
    });

    it('registers autopilot.stop method', () => {
      expect(mock.gatewayMethods.has('autopilot.stop')).toBe(true);
    });

    it('registers autopilot.status method', () => {
      expect(mock.gatewayMethods.has('autopilot.status')).toBe(true);
    });
  });

  describe('session extension', () => {
    it('registers session extension with namespace autopilot', () => {
      const ext = mock.getSessionExtension();
      expect(ext).not.toBeNull();
      expect(ext.namespace).toBe('autopilot');
    });

    it('session extension has project function', () => {
      const ext = mock.getSessionExtension();
      expect(typeof ext.project).toBe('function');
    });

    it('project returns idle projection for unknown session', () => {
      const ext = mock.getSessionExtension();
      const result = ext.project({ sessionKey: 'unknown-session' });
      expect(result).toBeDefined();
      expect(result.status).toBe('idle');
      expect(result.enabled).toBe(false);
    });

    it('project does not report enabled from stale stored ctx.state when no active run', () => {
      const ext = mock.getSessionExtension();
      const result = ext.project({ sessionKey: 'unknown-session', state: { enabled: true } });
      expect(result).toBeDefined();
      expect(result.status).toBe('idle');
      expect(result.enabled).toBe(false);
    });

    it('project does not report enabled from stale action=activate in ctx.state', () => {
      const ext = mock.getSessionExtension();
      const result = ext.project({ sessionKey: 'unknown-session', state: { action: 'activate', ts: 123 } });
      expect(result).toBeDefined();
      expect(result.status).toBe('idle');
      expect(result.enabled).toBe(false);
    });

    it('project returns enabled=false when ctx.state has stop action', () => {
      const ext = mock.getSessionExtension();
      const result = ext.project({ sessionKey: 'unknown-session', state: { action: 'stop', ts: 123 } });
      expect(result).toBeDefined();
      expect(result.status).toBe('idle');
      expect(result.enabled).toBe(false);
    });
  });

  describe('activate + finalize flow', () => {
    it('activate creates running state, before_agent_finalize returns revise', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-1' }, respond });
      expect(respond.mock.calls[0][0]).toBe(true);

      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-1', sessionKey: 'sess-1' });

      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      const finalizeResult = await finalizeHandler({
        sessionId: 'sid-1',
        sessionKey: 'sess-1',
        runId: expect.any(String),
        stopHookActive: false,
        lastAssistantMessage: 'I will continue working on this.',
      });

      expect(finalizeResult.action).toBe('revise');
      expect(finalizeResult.retry).toBeDefined();
      expect(finalizeResult.retry.instruction).toBeDefined();
    });

    it('before_agent_finalize returns continue when autopilot not activated', async () => {
      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      const result = await finalizeHandler({
        sessionId: 'sid-1',
        sessionKey: 'sess-1',
        stopHookActive: false,
        lastAssistantMessage: 'hello',
      });
      expect(result.action).toBe('continue');
    });

    it('stop deactivates autopilot', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const stopHandler = mock.gatewayMethods.get('autopilot.stop')!;

      const respondActivate = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-1' }, respond: respondActivate });
      const respondStop = vi.fn();
      await stopHandler({ params: { sessionKey: 'sess-1' }, respond: respondStop });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-1' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;
      expect(projection.status).toBe('idle');
    });

    it('activate returns error when session is already running', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;

      const respond1 = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-1' }, respond: respond1 });
      const respond2 = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-1' }, respond: respond2 });

      expect(respond2.mock.calls[0][0]).toBe(false);
      expect(respond2.mock.calls[0][2]?.message).toContain('cannot activate');
    });
  });

  describe('completion detection', () => {
    it('returns finalize (via complete) when task signals completion', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-1' }, respond: _respond });

      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-1', sessionKey: 'sess-1' });

      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      await driveNonCompletionTurns(finalizeHandler, 'sid-1', 'sess-1');
      const result = await finalizeHandler({
        sessionId: 'sid-1',
        sessionKey: 'sess-1',
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成，代码通过了全部测试。',
      });

      expect(result.action).toBe('finalize');
    });
  });

  describe('tool error tracking', () => {
    it('after_tool_call tracks errors by sessionKey and triggers pause on threshold', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-1' }, respond: _respond });

      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-1', sessionKey: 'sess-1' });

      const afterToolHandler = mock.hooks.get('after_tool_call')!;
      // Send 3 repeated errors (same tool+args) — should trigger threshold
      for (let i = 0; i < 3; i++) {
        await afterToolHandler({
          toolName: 'bash',
          params: { cmd: 'fail' },
          error: 'exit 1',
          sessionKey: 'sess-1',
        });
      }

      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      const result = await finalizeHandler({
        sessionId: 'sid-1',
        sessionKey: 'sess-1',
        stopHookActive: false,
        lastAssistantMessage: 'working...',
      });

      // Should pause due to tool_error_repeated threshold
      expect(result.action).toBe('finalize');
    });

    it('after_tool_call with single error still allows revise', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-1' }, respond: _respond });

      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-1', sessionKey: 'sess-1' });

      const afterToolHandler = mock.hooks.get('after_tool_call')!;
      await afterToolHandler({
        toolName: 'bash',
        params: { cmd: 'fail' },
        error: 'exit 1',
        sessionKey: 'sess-1',
      });

      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      const result = await finalizeHandler({
        sessionId: 'sid-1',
        sessionKey: 'sess-1',
        stopHookActive: false,
        lastAssistantMessage: 'working...',
      });

      expect(result.action).toBe('revise');
    });
  });

  describe('agent_turn_prepare hook', () => {
    async function activateSession(sessionKey: string) {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey }, respond: _respond });
      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: `sid-${sessionKey}`, sessionKey });
    }

    it('returns undefined when autopilot not enabled', () => {
      const handler = mock.hooks.get('agent_turn_prepare')!;
      const result = handler({ prompt: 'do something' }, { sessionKey: 'sess-1' });
      expect(result).toBeUndefined();
    });

    it('captures goal from first prompt', async () => {
      await activateSession('sess-atp1');
      const handler = mock.hooks.get('agent_turn_prepare')!;

      handler({ prompt: '帮我重构 auth 模块' }, { sessionKey: 'sess-atp1' });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-atp1' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;
      expect(projection.lastGoal).toContain('重构 auth 模块');
    });

    it('does not overwrite existing goal on subsequent turns', async () => {
      await activateSession('sess-atp2');
      const handler = mock.hooks.get('agent_turn_prepare')!;

      handler({ prompt: '帮我重构 auth 模块' }, { sessionKey: 'sess-atp2' });
      handler({ prompt: '继续执行其他任务' }, { sessionKey: 'sess-atp2' });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-atp2' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;
      expect(projection.lastGoal).toContain('重构 auth 模块');
      expect(projection.lastGoal).not.toContain('其他任务');
    });

    it('injects goal and completion instruction as appendContext', async () => {
      await activateSession('sess-atp3');
      const handler = mock.hooks.get('agent_turn_prepare')!;

      // Set a goal first
      handler({ prompt: '实现用户认证功能' }, { sessionKey: 'sess-atp3' });

      // Second call should inject reinforcement
      const result = handler({ prompt: '继续' }, { sessionKey: 'sess-atp3' });

      expect(result).toBeDefined();
      expect(result.appendContext).toContain('实现用户认证功能');
      expect(result.appendContext).toContain('All tasks completed');
    });

    it('resumes injection after compaction restores and clears goalSnapshot', async () => {
      await activateSession('sess-atp4');
      const handler = mock.hooks.get('agent_turn_prepare')!;

      // Set a goal
      handler({ prompt: '实现登录功能' }, { sessionKey: 'sess-atp4' });

      // Simulate compaction: before_compaction → after_compaction sets then clears goalSnapshot
      const beforeCompaction = mock.hooks.get('before_compaction')!;
      beforeCompaction({ sessionKey: 'sess-atp4' });
      const afterCompaction = mock.hooks.get('after_compaction')!;
      afterCompaction({ sessionKey: 'sess-atp4' });

      // After compaction, goalSnapshot is cleared, so agent_turn_prepare should inject again
      const result = handler({ prompt: '继续' }, { sessionKey: 'sess-atp4' });
      expect(result).toBeDefined();
      expect(result.appendContext).toContain('实现登录功能');
    });
  });

  describe('before_agent_run gate', () => {
    async function activateSession(sessionKey: string) {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey }, respond: _respond });
    }

    it('returns pass when autopilot not enabled', () => {
      const handler = mock.hooks.get('before_agent_run')!;
      const result = handler({}, { sessionKey: 'sess-1' });
      expect(result.outcome).toBe('pass');
    });

    it('returns pass when no sessionKey in context', () => {
      const handler = mock.hooks.get('before_agent_run')!;
      const result = handler({}, {});
      expect(result.outcome).toBe('pass');
    });

    it('returns pass for non-excluded agent when autopilot active', async () => {
      await activateSession('sess-bar1');
      const handler = mock.hooks.get('before_agent_run')!;
      const result = handler({}, { sessionKey: 'sess-bar1', agentId: 'default' });
      expect(result.outcome).toBe('pass');
    });
  });

  describe('before_agent_run gate with excludedAgents config', () => {
    it('blocks excluded agent when autopilot active', async () => {
      _resetForTest();
      const mockWithExclusion = createMockApi();
      mockWithExclusion.api.pluginConfig = {
        excludedAgents: ['heartbeat-agent'],
      };
      register(mockWithExclusion.api as any);

      // Activate autopilot
      const activateHandler = mockWithExclusion.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-exc1' }, respond: _respond });

      const handler = mockWithExclusion.hooks.get('before_agent_run')!;
      const result = handler({}, { sessionKey: 'sess-exc1', agentId: 'heartbeat-agent' });

      expect(result.outcome).toBe('block');
      expect(result.reason).toContain('heartbeat-agent');
    });

    it('passes non-excluded agent in same session', async () => {
      _resetForTest();
      const mockWithExclusion = createMockApi();
      mockWithExclusion.api.pluginConfig = {
        excludedAgents: ['heartbeat-agent'],
      };
      register(mockWithExclusion.api as any);

      const activateHandler = mockWithExclusion.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-exc2' }, respond: _respond });

      const handler = mockWithExclusion.hooks.get('before_agent_run')!;
      const result = handler({}, { sessionKey: 'sess-exc2', agentId: 'main-agent' });

      expect(result.outcome).toBe('pass');
    });
  });

  describe('before_tool_call approval', () => {
    async function activateSession(sessionKey: string) {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey }, respond: _respond });
    }

    it('returns undefined when autopilot not enabled', () => {
      const handler = mock.hooks.get('before_tool_call')!;
      const result = handler(
        { toolName: 'bash', params: { cmd: 'rm -rf /' } },
        { sessionKey: 'sess-1' },
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined for non-code-exec tool without highRiskTools config', async () => {
      await activateSession('sess-btc1');
      const handler = mock.hooks.get('before_tool_call')!;
      const result = handler(
        { toolName: 'read_file', params: { path: '/tmp/test' } },
        { sessionKey: 'sess-btc1' },
      );
      expect(result).toBeUndefined();
    });

    it('blocks credential_access tools', async () => {
      await activateSession('sess-btc2');
      const handler = mock.hooks.get('before_tool_call')!;
      const result = handler(
        { toolName: 'get-credential', toolKind: 'credential_access', args: [] },
        { sessionKey: 'sess-btc2' },
      );

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.blockReason).toBeDefined();
    });

    it('block result has no onResolution callback (hard veto, no approval channel)', async () => {
      await activateSession('sess-btc3');
      const handler = mock.hooks.get('before_tool_call')!;
      const result = handler(
        { toolName: 'sudo', args: ['rm', '-rf', '/'] },
        { sessionKey: 'sess-btc3' },
      );

      // Hard block has no onResolution — it's a veto, not an approval prompt
      expect(result.block).toBe(true);
      expect(result.requireApproval).toBeUndefined();
    });
  });

  describe('before_tool_call approval with highRiskTools config', () => {
    it('requires approval for configured high-risk tool', async () => {
      _resetForTest();
      const mockWithConfig = createMockApi();
      mockWithConfig.api.pluginConfig = {
        highRiskTools: ['apply_patch', 'delete_file'],
      };
      register(mockWithConfig.api as any);

      const activateHandler = mockWithConfig.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-hrt1' }, respond: _respond });

      const handler = mockWithConfig.hooks.get('before_tool_call')!;
      const result = handler(
        { toolName: 'delete_file', params: { path: '/important/file' } },
        { sessionKey: 'sess-hrt1' },
      );

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain('delete_file');
    });

    it('does not require approval for non-configured tool', async () => {
      _resetForTest();
      const mockWithConfig = createMockApi();
      mockWithConfig.api.pluginConfig = {
        highRiskTools: ['apply_patch', 'delete_file'],
      };
      register(mockWithConfig.api as any);

      const activateHandler = mockWithConfig.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-hrt2' }, respond: _respond });

      const handler = mockWithConfig.hooks.get('before_tool_call')!;
      const result = handler(
        { toolName: 'read_file', params: { path: '/safe/file' } },
        { sessionKey: 'sess-hrt2' },
      );

      expect(result).toBeUndefined();
    });
  });

  describe('done state transitions', () => {
    it('can activate from done state (restart)', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;

      const respond1 = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-done1' }, respond: respond1 });
      expect(respond1.mock.calls[0][0]).toBe(true);

      // Complete the session via completion detection
      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-done1', sessionKey: 'sess-done1' });

      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      await driveNonCompletionTurns(finalizeHandler, 'sid-done1', 'sess-done1');
      // ADR-020: advance orchState claimed → running so completion reaches done
      // via the reducer, not the removed complete() backdoor.
      mock.hooks.get('agent_turn_prepare')!({ prompt: 'task' }, { sessionKey: 'sess-done1' });
      await finalizeHandler({
        sessionId: 'sid-done1',
        sessionKey: 'sess-done1',
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成',
      });

      // Verify done state
      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus1 = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-done1' }, respond: respondStatus1 });
      const projection = respondStatus1.mock.calls[0][1]?.projection;
      expect(projection.status).toBe('done');
      expect(projection.canStop).toBe(true);

      // Reactivate from done
      const respondReactivate = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-done1' }, respond: respondReactivate });
      expect(respondReactivate.mock.calls[0][0]).toBe(true);

      // Verify counters are reset in new run
      const respondStatus2 = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-done1' }, respond: respondStatus2 });
      const newProjection = respondStatus2.mock.calls[0][1]?.projection;
      expect(newProjection.totalContinuations).toBe(0);
      expect(newProjection.status).toBe('running');
    });

    it('can stop from done state', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const stopHandler = mock.gatewayMethods.get('autopilot.stop')!;

      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-done2' }, respond: _respond });

      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-done2', sessionKey: 'sess-done2' });

      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      await driveNonCompletionTurns(finalizeHandler, 'sid-done2', 'sess-done2');
      await finalizeHandler({
        sessionId: 'sid-done2',
        sessionKey: 'sess-done2',
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成',
      });

      // Stop from done
      const respondStop = vi.fn();
      await stopHandler({ params: { sessionKey: 'sess-done2' }, respond: respondStop });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-done2' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;
      expect(projection.status).toBe('idle');
    });
  });

  describe('llm_output token tracking', () => {
    async function activateSession(sessionKey: string) {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey }, respond: _respond });
    }

    it('registers llm_output hook', () => {
      expect(mock.hooks.has('llm_output')).toBe(true);
    });

    it('does nothing when autopilot not enabled', () => {
      const handler = mock.hooks.get('llm_output')!;
      // Should not throw
      handler(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['hello'], usage: { input: 100, output: 50, total: 150 } },
        { sessionKey: 'sess-lt1' },
      );
    });

    it('accumulates token usage from llm_output events', async () => {
      await activateSession('sess-lt2');
      const handler = mock.hooks.get('llm_output')!;

      handler(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['step 1'], usage: { input: 1000, output: 500, total: 1500 } },
        { sessionKey: 'sess-lt2' },
      );
      handler(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['step 2'], usage: { input: 2000, output: 800, total: 2800 } },
        { sessionKey: 'sess-lt2' },
      );

      // Verify accumulated tokens via status projection
      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-lt2' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;
      expect(projection.totalTokensUsed).toBe(4300);
    });

    it('does not double-count inputTokensUsed/outputTokensUsed from llm_output', async () => {
      // Regression: index.ts previously incremented input/output manually AND passed
      // the same delta to orchestratorReducer which increments them again → 2x bug.
      // Fix: only orchestratorReducer updates input/output; index.ts only tracks totalTokensUsed.
      await activateSession('sess-lt-nodup');
      const handler = mock.hooks.get('llm_output')!;

      handler(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['step 1'], usage: { input: 1000, output: 500, total: 1500 } },
        { sessionKey: 'sess-lt-nodup' },
      );

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-lt-nodup' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;

      expect(projection.inputTokensUsed).toBe(1000);   // must be 1000, not 2000
      expect(projection.outputTokensUsed).toBe(500);   // must be 500, not 1000
      expect(projection.totalTokensUsed).toBe(1500);
    });

    it('does not accumulate tokens without usage data', async () => {
      await activateSession('sess-lt3');
      const handler = mock.hooks.get('llm_output')!;

      handler(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['no usage'] },
        { sessionKey: 'sess-lt3' },
      );

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-lt3' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;
      expect(projection.totalTokensUsed).toBe(0);
    });
  });

  describe('llm_output token budget enforcement', () => {
    it('pauses when accumulated tokens exceed tokenBudget', async () => {
      _resetForTest();
      const mockWithBudget = createMockApi();
      mockWithBudget.api.pluginConfig = {
        tokenBudget: 5000,
      };
      register(mockWithBudget.api as any);

      const activateHandler = mockWithBudget.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-budget1' }, respond: _respond });

      const sessionStartHandler = mockWithBudget.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-b1', sessionKey: 'sess-budget1' });

      const llmHandler = mockWithBudget.hooks.get('llm_output')!;
      llmHandler(
        { runId: 'r1', sessionId: 'sid-b1', provider: 'openai', model: 'gpt-4', assistantTexts: ['step 1'], usage: { input: 3000, output: 2500, total: 5500 } },
        { sessionKey: 'sess-budget1' },
      );

      // Next finalize should pause due to token budget exceeded
      const finalizeHandler = mockWithBudget.hooks.get('before_agent_finalize')!;
      const result = await finalizeHandler({
        sessionId: 'sid-b1',
        sessionKey: 'sess-budget1',
        stopHookActive: false,
        lastAssistantMessage: '继续工作中...',
      });

      expect(result.action).toBe('finalize'); // pause path

      const statusHandler = mockWithBudget.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-budget1' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;
      expect(projection.status).toBe('paused');
      expect(projection.pauseReason).toBe('token_budget_exceeded');
    });

    it('does not pause when tokens are under budget', async () => {
      _resetForTest();
      const mockWithBudget = createMockApi();
      mockWithBudget.api.pluginConfig = {
        tokenBudget: 10000,
      };
      register(mockWithBudget.api as any);

      const activateHandler = mockWithBudget.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-budget2' }, respond: _respond });

      const sessionStartHandler = mockWithBudget.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-b2', sessionKey: 'sess-budget2' });

      const llmHandler = mockWithBudget.hooks.get('llm_output')!;
      llmHandler(
        { runId: 'r1', sessionId: 'sid-b2', provider: 'openai', model: 'gpt-4', assistantTexts: ['step 1'], usage: { input: 1000, output: 500, total: 1500 } },
        { sessionKey: 'sess-budget2' },
      );

      const finalizeHandler = mockWithBudget.hooks.get('before_agent_finalize')!;
      const result = await finalizeHandler({
        sessionId: 'sid-b2',
        sessionKey: 'sess-budget2',
        stopHookActive: false,
        lastAssistantMessage: '继续工作中...',
      });

      // Should not pause — still under budget
      expect(result.action).toBe('revise');
    });
  });

  describe('canary degradation detection', () => {
    async function activateSession(sessionKey: string) {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey }, respond: _respond });
    }

    it('marks degraded when agent_end fires without before_agent_finalize', async () => {
      await activateSession('sess-canary1');

      const agentEndHandler = mock.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-canary1',
        sessionKey: 'sess-canary1',
        success: true,
        messages: [],
      });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-canary1' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;
      expect(projection.degraded).toBe(true);
    });

    // code-review finding #1 (ADR-020 step 1 race): if the run transitions off
    // 'running' during the degraded enqueue await (concurrent stop/pause/stall),
    // the host has already enqueued a cross-turn. cross_turn_degraded must NOT
    // be recorded — otherwise the user's stop is overridden for an uncounted
    // turn and a false success warn fires. The stale injection fires once but
    // before_agent_finalize returns 'finalize' for a non-running run.
    it('does not record cross_turn_degraded when the run races off running during enqueue (code-review #1)', async () => {
      await activateSession('sess-race1');

      // Simulate a concurrent stop arriving during the enqueue await: the host
      // enqueued the cross-turn, but by the time the await resolves the run has
      // transitioned off running.
      mock.api.enqueueNextTurnInjection.mockImplementationOnce(async (injection: { sessionKey: string }) => {
        const stop = mock.gatewayMethods.get('autopilot.stop')!;
        await stop({ params: { sessionKey: injection.sessionKey }, respond: vi.fn() });
        return { enqueued: true, id: 'inj-race', sessionKey: injection.sessionKey };
      });

      const agentEndHandler = mock.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-race1',
        sessionKey: 'sess-race1',
        success: true,
        messages: [],
      });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respond = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-race1' }, respond });
      const projection = respond.mock.calls[0][1]?.projection;
      // cross_turn_degraded was NOT dispatched: degraded stayed false and
      // totalContinuations was not incremented, despite enqueue succeeding.
      expect(projection.degraded).toBe(false);
      expect(projection.totalContinuations).toBe(0);
    });

    it('does not mark degraded when before_agent_finalize has fired', async () => {
      await activateSession('sess-canary2');

      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      await finalizeHandler({
        sessionId: 'sid-canary2',
        sessionKey: 'sess-canary2',
        stopHookActive: false,
        lastAssistantMessage: 'working...',
      });

      const agentEndHandler = mock.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-canary2',
        sessionKey: 'sess-canary2',
        success: true,
        messages: [],
      });

      const statusHandler2 = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus2 = vi.fn();
      await statusHandler2({ params: { sessionKey: 'sess-canary2' }, respond: respondStatus2 });
      const projection2 = respondStatus2.mock.calls[0][1]?.projection;
      expect(projection2.degraded).toBe(false);
    });

    // GAP-24: degraded should be cleared when next agent_end fires with canary (recovery)
    it('clears degraded when next agent_end has canary fired (GAP-24 recovery)', async () => {
      await activateSession('sess-recover1');

      // Run 1: agent_end WITHOUT before_agent_finalize → degraded
      const agentEndHandler = mock.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-recover1',
        sessionKey: 'sess-recover1',
        success: true,
        messages: [],
      });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus1 = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-recover1' }, respond: respondStatus1 });
      expect(respondStatus1.mock.calls[0][1]?.projection.degraded).toBe(true);

      // Run 2: before_agent_finalize fires normally, then agent_end → should CLEAR degraded
      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      await finalizeHandler({
        sessionId: 'sid-recover1',
        sessionKey: 'sess-recover1',
        stopHookActive: false,
        lastAssistantMessage: 'working...',
      });

      await agentEndHandler({
        sessionId: 'sid-recover1',
        sessionKey: 'sess-recover1',
        success: true,
        messages: [],
      });

      const respondStatus2 = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-recover1' }, respond: respondStatus2 });
      expect(respondStatus2.mock.calls[0][1]?.projection.degraded).toBe(false);
    });

    it('clears canary between agent runs so second run without finalize triggers degraded', async () => {
      await activateSession('sess-canary3');

      // Run 1: before_agent_finalize fires, then agent_end — no degradation
      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      await finalizeHandler({
        sessionId: 'sid-canary3',
        sessionKey: 'sess-canary3',
        stopHookActive: false,
        lastAssistantMessage: 'working...',
      });

      const agentEndHandler = mock.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-canary3',
        sessionKey: 'sess-canary3',
        success: true,
        messages: [],
      });

      // Verify not degraded after run 1
      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus1 = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-canary3' }, respond: respondStatus1 });
      expect(respondStatus1.mock.calls[0][1]?.projection.degraded).toBe(false);

      // Run 2: agent_end WITHOUT before_agent_finalize — should trigger degraded
      await agentEndHandler({
        sessionId: 'sid-canary3',
        sessionKey: 'sess-canary3',
        success: true,
        messages: [],
      });

      const respondStatus2 = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-canary3' }, respond: respondStatus2 });
      expect(respondStatus2.mock.calls[0][1]?.projection.degraded).toBe(true);
    });

    it('sets cross-turn resume when degraded fallback enqueue is rejected', async () => {
      mock.api.enqueueNextTurnInjection.mockResolvedValueOnce({ enqueued: false, id: '', sessionKey: '' });
      await activateSession('sess-canary4');

      const agentEndHandler = mock.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-canary4',
        sessionKey: 'sess-canary4',
        success: true,
        messages: [],
      });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-canary4' }, respond: respondStatus });
      expect(respondStatus.mock.calls[0][1]?.projection.needsCrossTurnResume).toBe(true);
      expect(respondStatus.mock.calls[0][1]?.projection.degraded).toBe(true);
      // E8/P1-9: rejected-fallback path must advance totalContinuations (0 -> 1).
      expect(respondStatus.mock.calls[0][1]?.projection.totalContinuations).toBe(1);
    });

    it('sets cross-turn resume when degraded fallback enqueue rejects', async () => {
      mock.api.enqueueNextTurnInjection.mockRejectedValueOnce(new Error('inject failed'));
      await activateSession('sess-canary5');

      const agentEndHandler = mock.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-canary5',
        sessionKey: 'sess-canary5',
        success: true,
        messages: [],
      });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-canary5' }, respond: respondStatus });
      expect(respondStatus.mock.calls[0][1]?.projection.needsCrossTurnResume).toBe(true);
      expect(respondStatus.mock.calls[0][1]?.projection.degraded).toBe(true);
      // E8/P1-9: throws-fallback path must advance totalContinuations (0 -> 1).
      expect(respondStatus.mock.calls[0][1]?.projection.totalContinuations).toBe(1);
    });
  });

  describe('agent_end degraded fallback recovery', () => {
    async function activateSession(sessionKey: string) {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey }, respond: _respond });
      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: `sid-${sessionKey}`, sessionKey });
    }

    it('agent_end degraded fallback sets needsCrossTurnResume when injection unavailable', async () => {
      // Remove enqueueNextTurnInjection so injection API is unavailable
      const originalFn = mock.api.enqueueNextTurnInjection;
      mock.api.session.workflow.enqueueNextTurnInjection = undefined;

      await activateSession('sess-m3-1');

      // Do NOT fire before_agent_finalize so canaryFired is false
      const agentEndHandler = mock.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-sess-m3-1',
        sessionKey: 'sess-m3-1',
        success: true,
        messages: [],
      });

      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-m3-1' }, respond: respondStatus });
      const projection = respondStatus.mock.calls[0][1]?.projection;

      // degraded must be true AND needsCrossTurnResume must be true for recovery
      expect(projection.degraded).toBe(true);
      expect(projection.needsCrossTurnResume).toBe(true);
      // E8/P1-9: the fallback must advance totalContinuations or degraded mode has
      // no termination (0 -> 1). A regression that drops the increment leaves this 0.
      expect(projection.totalContinuations).toBe(1);

      // Restore
      mock.api.session.workflow.enqueueNextTurnInjection = originalFn;
    });
  });

  describe('activate from done goal preservation with truncation', () => {
    it('activate from done preserves goal with length truncation', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-m4-1' }, respond: _respond });

      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-m4-1', sessionKey: 'sess-m4-1' });

      // Set a goal longer than 500 chars via setGoal action
      const setGoalHandler = mock.gatewayMethods.get('autopilot.setGoal')!;
      const longGoal = 'x'.repeat(600);
      const respondGoal = vi.fn();
      await setGoalHandler({ params: { sessionKey: 'sess-m4-1', goal: longGoal }, respond: respondGoal });

      // Complete the session
      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      await driveNonCompletionTurns(finalizeHandler, 'sid-m4-1', 'sess-m4-1');
      // ADR-020: advance orchState claimed → running (see done-restart test).
      mock.hooks.get('agent_turn_prepare')!({ prompt: 'task' }, { sessionKey: 'sess-m4-1' });
      await finalizeHandler({
        sessionId: 'sid-m4-1',
        sessionKey: 'sess-m4-1',
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成',
      });

      // Verify done state
      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondStatus1 = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-m4-1' }, respond: respondStatus1 });
      expect(respondStatus1.mock.calls[0][1]?.projection.status).toBe('done');

      // Reactivate from done — goal should be preserved but truncated to 500
      const respondReactivate = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-m4-1' }, respond: respondReactivate });

      const respondStatus2 = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-m4-1' }, respond: respondStatus2 });
      const newProjection = respondStatus2.mock.calls[0][1]?.projection;
      expect(newProjection.lastGoal).toBeDefined();
      expect(newProjection.lastGoal!.length).toBeLessThanOrEqual(500);
      expect(newProjection.lastGoal!.length).not.toBe(600);
    });
  });

  describe('setGoal action validation', () => {
    it('rejects non-string goal payloads without throwing', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-goal1' }, respond: _respond });

      const setGoalHandler = mock.gatewayMethods.get('autopilot.setGoal')!;
      const respondGoal1 = vi.fn();
      await setGoalHandler({ params: { sessionKey: 'sess-goal1', goal: { text: 'bad' } }, respond: respondGoal1 });

      const respondGoal2 = vi.fn();
      await setGoalHandler({ params: { sessionKey: 'sess-goal1', goal: { text: 'bad' } }, respond: respondGoal2 });
      expect(respondGoal2.mock.calls[0][0]).toBe(false);
      expect(respondGoal2.mock.calls[0][2]?.message).toContain('goal');
    });

    it('rejects blank goal payloads', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-goal2' }, respond: _respond });

      const setGoalHandler = mock.gatewayMethods.get('autopilot.setGoal')!;
      const respondGoal = vi.fn();
      await setGoalHandler({ params: { sessionKey: 'sess-goal2', goal: '   ' }, respond: respondGoal });

      expect(respondGoal.mock.calls[0][0]).toBe(false);
      expect(respondGoal.mock.calls[0][2]?.message).toContain('goal');
    });
  });

  // M-4: Degraded agent_end at max continuations should pause, not cross-turn
  describe('agent_end degraded at max continuations', () => {
    it('pauses with max_total_reached instead of setting needsCrossTurnResume', async () => {
      _resetForTest();
      const mockMaxTotal = createMockApi();
      mockMaxTotal.api.pluginConfig = { maxTotalContinuations: 5 };
      register(mockMaxTotal.api as any);

      const activateHandler = mockMaxTotal.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-m4test' }, respond: _respond });

      const sessionStartHandler = mockMaxTotal.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-m4t', sessionKey: 'sess-m4test' });

      // Drive totalContinuations to max via before_agent_finalize revise actions
      const finalizeHandler = mockMaxTotal.hooks.get('before_agent_finalize')!;
      for (let i = 0; i < 5; i++) {
        await finalizeHandler({
          sessionId: 'sid-m4t',
          sessionKey: 'sess-m4test',
          stopHookActive: false,
          lastAssistantMessage: 'working...',
        });
      }

      // Verify at max
      const statusHandler = mockMaxTotal.gatewayMethods.get('autopilot.status')!;
      const respondStatusBefore = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-m4test' }, respond: respondStatusBefore });
      expect(respondStatusBefore.mock.calls[0][1]?.projection.totalContinuations).toBe(5);

      // First agent_end clears the canary (normal path since finalize fired)
      const agentEndHandler = mockMaxTotal.hooks.get('agent_end')!;
      await agentEndHandler({
        sessionId: 'sid-m4t',
        sessionKey: 'sess-m4test',
        success: true,
        messages: [],
      });

      // Still running (normal agent_end just resets turnAttempts)
      const respondStatusMid = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-m4test' }, respond: respondStatusMid });
      expect(respondStatusMid.mock.calls[0][1]?.projection.status).toBe('running');

      // Second agent_end WITHOUT before_agent_finalize → degraded path at max continuations
      await agentEndHandler({
        sessionId: 'sid-m4t',
        sessionKey: 'sess-m4test',
        success: true,
        messages: [],
      });

      // Should be paused with max_total_reached, NOT needsCrossTurnResume
      const respondStatusAfter = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-m4test' }, respond: respondStatusAfter });
      expect(respondStatusAfter.mock.calls[0][1]?.projection.status).toBe('paused');
      expect(respondStatusAfter.mock.calls[0][1]?.projection.pauseReason).toBe('max_total_reached');
    });
  });

  // H-1: Async cross-turn should preserve intermediate state changes (tokens)
  describe('async cross-turn state preservation', () => {
    it('preserves llm_output token updates during cross-turn await', async () => {
      const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
      const _respond = vi.fn();
      await activateHandler({ params: { sessionKey: 'sess-h1' }, respond: _respond });

      const sessionStartHandler = mock.hooks.get('session_start')!;
      await sessionStartHandler({ sessionId: 'sid-h1', sessionKey: 'sess-h1' });

      // Drive turnAttempts to maxAttemptsPerTurn (5) so decideContinuation returns cross_turn
      const finalizeHandler = mock.hooks.get('before_agent_finalize')!;
      for (let i = 0; i < 5; i++) {
        await finalizeHandler({
          sessionId: 'sid-h1',
          sessionKey: 'sess-h1',
          stopHookActive: false,
          lastAssistantMessage: 'working...',
        });
      }

      // Check tokens before cross-turn
      const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
      const respondBefore = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-h1' }, respond: respondBefore });
      const tokensBefore = respondBefore.mock.calls[0][1]?.projection.totalTokensUsed;

      // Simulate llm_output adding tokens DURING the cross-turn await
      // (In real code this happens during the await of enqueueNextTurnInjection)
      const llmHandler = mock.hooks.get('llm_output')!;
      llmHandler(
        { runId: 'r1', sessionId: 'sid-h1', provider: 'openai', model: 'gpt-4', assistantTexts: ['extra'], usage: { input: 500, output: 200, total: 700 } },
        { sessionKey: 'sess-h1' },
      );

      // The next finalize should still show the 700 extra tokens
      const respondAfter = vi.fn();
      await statusHandler({ params: { sessionKey: 'sess-h1' }, respond: respondAfter });
      expect(respondAfter.mock.calls[0][1]?.projection.totalTokensUsed).toBe(tokensBefore + 700);
    });
  });

  // M1: end-to-end coverage of the before_model_resolve hook wiring.
  // The pure functions (resolveModelTier/resolveModelId/isSubagentSession) are
  // covered in model-routing.test.ts, but the HOOK itself — activate→findRun→
  // precedence→return { modelOverride } — was previously untested. This freezes
  // the wiring so a regression in any branch ships red.
  describe('before_model_resolve hook (model routing)', () => {
    // Config used by the tier-routing scenarios: all three tiers have a modelId.
    const routingConfig = {
      defaultTier: 'standard',
      initialTurnTier: 'premium',
      validationTier: 'budget',
      subagentTier: 'budget',
      modelIds: {
        budget: 'haiku-4-5',
        standard: 'sonnet-4-6',
        premium: 'opus-4-8',
      },
    };

    /** Activate a run, return the captured before_model_resolve handler. */
    async function setupRouting(sessionKey: string, pluginConfig: Record<string, unknown>) {
      _resetForTest();
      const m = createMockApi();
      m.api.pluginConfig = pluginConfig;
      register(m.api as any);

      const activateHandler = m.gatewayMethods.get('autopilot.activate')!;
      await activateHandler({ params: { sessionKey }, respond: vi.fn() });

      const hook = m.hooks.get('before_model_resolve')!;
      return { hook, m };
    }

    it('initial turn (totalContinuations 0) -> initialTurnTier model', async () => {
      const { hook } = await setupRouting('sess-mr1', { modelRouting: routingConfig });

      const result = hook({}, { sessionKey: 'sess-mr1' });
      expect(result).toEqual({ modelOverride: 'opus-4-8' });
    });

    it('implementation turn (totalContinuations >= 2) -> defaultTier model', async () => {
      const { hook, m } = await setupRouting('sess-mr2', { modelRouting: routingConfig });

      // Drive two non-completion finalize turns to bump totalContinuations past
      // the initial-turn threshold (<= 1). Each revise increments the counter.
      const finalizeHandler = m.hooks.get('before_agent_finalize')!;
      await driveNonCompletionTurns(finalizeHandler, 'sid-mr2', 'sess-mr2');

      const result = hook({}, { sessionKey: 'sess-mr2' });
      expect(result).toEqual({ modelOverride: 'sonnet-4-6' });
    });

    it('subagent session key -> subagentTier model (parent run resolved)', async () => {
      // Activate the PARENT (main) session; the subagent key must resolve back
      // to the parent run via isSubagentSession + extractParentSessionKey.
      const { hook } = await setupRouting('agent:main', { modelRouting: routingConfig });

      const result = hook({}, { sessionKey: 'agent:main:subagent:task-1' });
      expect(result).toEqual({ modelOverride: 'haiku-4-5' });
    });

    it('unconfigured modelIds -> no override (inherit declared model)', async () => {
      // defaultTier set (so parseModelRouting returns a config) but no modelIds
      // => resolveModelId returns undefined => hook returns undefined. This is
      // the §6.3 "no interference" contract: unconfigured = inherit.
      const { hook } = await setupRouting('sess-mr4', {
        modelRouting: { defaultTier: 'standard' },
      });

      const result = hook({}, { sessionKey: 'sess-mr4' });
      expect(result).toBeUndefined();
    });

    it('run not in running state -> no override', async () => {
      // No modelRouting configured AND activate leaves status='running', so to
      // exercise the status gate we stop the run first, then call the hook.
      const { hook, m } = await setupRouting('sess-mr5', {
        modelRouting: routingConfig,
      });
      const stopHandler = m.gatewayMethods.get('autopilot.stop')!;
      await stopHandler({ params: { sessionKey: 'sess-mr5' }, respond: vi.fn() });

      const result = hook({}, { sessionKey: 'sess-mr5' });
      expect(result).toBeUndefined();
    });

    // ─── INT-3 (ADR-017): child declared model wins over parent subagentTier ─
    // The host surfaces a subagent's resolved `.prose model:` via ctx.modelId
    // BEFORE the hook fires. When present, the child's declaration is honored
    // (no override); the parent subagentTier only applies to children that
    // declared nothing.
    it('INT-3: subagent with declared model (ctx.modelId) -> inherit, no override', async () => {
      const { hook } = await setupRouting('agent:main', { modelRouting: routingConfig });

      // Child declared opus; parent has subagentTier: budget configured.
      // Child intent wins => no modelOverride => host keeps the declared model.
      const result = hook({}, { sessionKey: 'agent:main:subagent:judge', modelId: 'declared-opus' });
      expect(result).toBeUndefined();
    });

    it('INT-3: subagent WITHOUT declared model -> parent subagentTier fallback', async () => {
      const { hook } = await setupRouting('agent:main', { modelRouting: routingConfig });

      // Child declared nothing (ctx.modelId absent) => parent subagentTier applies.
      const result = hook({}, { sessionKey: 'agent:main:subagent:worker' });
      expect(result).toEqual({ modelOverride: 'haiku-4-5' });
    });

    it('INT-3: main agent with ctx.modelId still gets tier routing (guard is subagent-only)', async () => {
      const { hook } = await setupRouting('sess-mr-main', { modelRouting: routingConfig });

      // Main agent (non-subagent key) with a modelId in ctx: the INT-3 guard
      // must NOT fire — tier routing still applies for the main agent.
      const result = hook({}, { sessionKey: 'sess-mr-main', modelId: 'some-model' });
      expect(result).toEqual({ modelOverride: 'opus-4-8' });
    });
  });
});
