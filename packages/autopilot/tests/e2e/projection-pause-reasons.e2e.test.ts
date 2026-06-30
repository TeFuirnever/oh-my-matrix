/**
 * E2E: every pause reason observable via AutopilotProjection + token/cost projection.
 *
 * Drives each pause path (tool_error_repeated, token_budget_exceeded,
 * max_total_reached, loop_breaker_triggered) and asserts
 * projection.status==='paused' && projection.pauseReason. Also exercises the
 * llm_output token accounting and the cost formula in projectState(), plus the
 * H4 NaN/negative guard (malformed usage must add 0, never NaN/Infinity cost).
 *
 * CODE is truth — expected values read from the live source:
 *   - projection.ts: AUTOPILOT_INPUT_COST_PER_M_USD = 3.0,
 *                    AUTOPILOT_OUTPUT_COST_PER_M_USD = 15.0,
 *                    estimatedCostUsd = (in*3.0 + out*15.0)/1e6
 *   - continuation-engine.ts: pause reasons emitted by decideContinuation
 *   - index.ts llm_output hook: H4 guard (Number.isFinite && >=0 else added=0)
 *
 * Imports from ../src and ../index (no build step). Vitest config include
 * (tests slash double-star slash dot-test.ts) matches this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register, _resetForTest } from '../../index';
import {
  AUTOPILOT_INPUT_COST_PER_M_USD,
  AUTOPILOT_OUTPUT_COST_PER_M_USD,
  projectState,
} from '../../src/projection';
import type { AutopilotState } from '../../src/types';

// --- shared mock (copied from tests/plugin-entry.test.ts) -------------------
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

/** Read the projection for a session via the autopilot.status gateway method. */
async function readProjection(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
  const respond = vi.fn();
  await statusHandler({ params: { sessionKey }, respond });
  return respond.mock.calls[0][1]?.projection;
}

async function activate(mock: ReturnType<typeof createMockApi>, sessionKey: string, pluginConfig: Record<string, unknown> = {}) {
  Object.assign(mock.api.pluginConfig, pluginConfig);
  const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
  await activateHandler({ params: { sessionKey }, respond: vi.fn() });
  const sessionStartHandler = mock.hooks.get('session_start')!;
  await sessionStartHandler({ sessionId: `sid-${sessionKey}`, sessionKey });
}

describe('E2E: AutopilotProjection pause reasons + token/cost accounting', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
  });

  /** register() reads api.pluginConfig ONCE at registration time (index.ts:263),
   *  so config-bearing suites must reset + re-register with the config populated. */
  function setupWithConfig(pluginConfig: Record<string, unknown>) {
    _resetForTest();
    mock = createMockApi();
    Object.assign(mock.api.pluginConfig, pluginConfig);
    register(mock.api as any);
  }

  describe('cost constants + formula (read from projection.ts)', () => {
    it('exposes the verified Sonnet pricing constants', () => {
      // frozen to current behavior — projection.ts:45-46
      expect(AUTOPILOT_INPUT_COST_PER_M_USD).toBe(3.0);
      expect(AUTOPILOT_OUTPUT_COST_PER_M_USD).toBe(15.0);
    });

    it('projectState computes estimatedCostUsd = (in*3.0 + out*15.0)/1e6', () => {
      // frozen to current behavior — projection.ts:57-58
      const state = {
        status: 'running', enabled: true, turnAttempts: 0, totalContinuations: 0,
        maxAttemptsPerTurn: 5, maxTotalContinuations: 50, maxConcurrentAutopilot: 5,
        needsCrossTurnResume: false, totalTokensUsed: 1000, degraded: false,
        inputTokensUsed: 200_000, outputTokensUsed: 50_000,
      } as unknown as AutopilotState;
      const proj = projectState(state)!;
      // (200000*3.0 + 50000*15.0)/1e6 = (600000 + 750000)/1e6 = 1.35
      expect(proj.estimatedCostUsd).toBe(1.35);
      expect(proj.inputTokensUsed).toBe(200_000);
      expect(proj.outputTokensUsed).toBe(50_000);
    });

    it('projectState cost is 0 when no token fields present', () => {
      const state = {
        status: 'running', enabled: true, turnAttempts: 0, totalContinuations: 0,
        maxAttemptsPerTurn: 5, maxTotalContinuations: 50, maxConcurrentAutopilot: 5,
        needsCrossTurnResume: false, totalTokensUsed: 0, degraded: false,
      } as unknown as AutopilotState;
      const proj = projectState(state)!;
      expect(proj.estimatedCostUsd).toBe(0);
      expect(proj.inputTokensUsed).toBe(0);
      expect(proj.outputTokensUsed).toBe(0);
    });
  });

  describe('token accounting accumulates from llm_output and projects cost', () => {
    it('accumulates totalTokensUsed across multiple llm_output events', async () => {
      await activate(mock, 'sess-tok1');
      const llm = mock.hooks.get('llm_output')!;
      llm(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['a'], usage: { input: 1000, output: 500, total: 1500 } },
        { sessionKey: 'sess-tok1' },
      );
      llm(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['b'], usage: { input: 2000, output: 800, total: 2800 } },
        { sessionKey: 'sess-tok1' },
      );

      const proj = await readProjection(mock, 'sess-tok1');
      // index.ts llm_output: totalTokensUsed += added (1500 + 2800)
      expect(proj.totalTokensUsed).toBe(4300);
      // input/output tracked by orchestrator agent_activity (no double-count — see plugin-entry test)
      expect(proj.inputTokensUsed).toBe(3000);
      expect(proj.outputTokensUsed).toBe(1300);
      // cost from accumulated input/output: (3000*3.0 + 1300*15.0)/1e6
      const expectedCost = (3000 * AUTOPILOT_INPUT_COST_PER_M_USD + 1300 * AUTOPILOT_OUTPUT_COST_PER_M_USD) / 1_000_000;
      expect(proj.estimatedCostUsd).toBeCloseTo(expectedCost, 10);
    });

    it('H4 guard: NaN usage.total adds 0 and never corrupts the total or yields NaN/Infinity cost', async () => {
      await activate(mock, 'sess-tok-nan');
      const llm = mock.hooks.get('llm_output')!;

      // seed a known-good accumulation
      llm(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['ok'], usage: { input: 100, output: 50, total: 150 } },
        { sessionKey: 'sess-tok-nan' },
      );

      // malformed usages: NaN total, negative total, Infinity total, non-number total
      llm(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['nan'], usage: { input: 999, output: 999, total: NaN } },
        { sessionKey: 'sess-tok-nan' },
      );
      llm(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['neg'], usage: { input: 999, output: 999, total: -500 } },
        { sessionKey: 'sess-tok-nan' },
      );
      llm(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['inf'], usage: { input: 999, output: 999, total: Infinity } },
        { sessionKey: 'sess-tok-nan' },
      );
      llm(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['str'], usage: { input: 999, output: 999, total: 'lots' as unknown as number } },
        { sessionKey: 'sess-tok-nan' },
      );

      const proj = await readProjection(mock, 'sess-tok-nan');
      // total unchanged: only the first good event (150) contributed
      expect(proj.totalTokensUsed).toBe(150);
      // cost must be a finite number — never NaN/Infinity
      expect(Number.isFinite(proj.estimatedCostUsd)).toBe(true);
      expect(proj.estimatedCostUsd).not.toBeNaN();
      expect(proj.estimatedCostUsd).not.toBe(Infinity);
      // input/output only from the good event (orchestrator agent_activity received
      // usage.input=999/output=999 on the malformed rows — those ARE finite numbers,
      // so they DO accumulate; only totalTokensUsed is guarded. Pin actual behavior.)
      // frozen to current behavior: input/output from orchestrator are NOT guarded by H4.
      expect(proj.inputTokensUsed).toBe(100 + 999 * 3);
      expect(proj.outputTokensUsed).toBe(50 + 999 * 3);
    });
  });

  describe('pause reason: tool_error_repeated', () => {
    it('3 repeated same-tool+args errors pause with tool_error_repeated', async () => {
      await activate(mock, 'sess-te');
      const afterTool = mock.hooks.get('after_tool_call')!;
      // default toolErrorThreshold is 3 (DEFAULT_CONFIG)
      for (let i = 0; i < 3; i++) {
        await afterTool({
          toolName: 'bash', params: { cmd: 'fail' }, error: 'exit 1', sessionKey: 'sess-te',
        });
      }

      const finalize = mock.hooks.get('before_agent_finalize')!;
      const result = await finalize({
        sessionId: 'sid-sess-te', sessionKey: 'sess-te', stopHookActive: false, lastAssistantMessage: 'working...',
      });
      // pause path returns finalize action and sets state to paused
      expect(result.action).toBe('finalize');

      const proj = await readProjection(mock, 'sess-te');
      expect(proj.status).toBe('paused');
      expect(proj.pauseReason).toBe('tool_error_repeated');
    });
  });

  describe('pause reason: token_budget_exceeded', () => {
    it('totalTokensUsed >= tokenBudget pauses with token_budget_exceeded', async () => {
      setupWithConfig({ tokenBudget: 5000 });
      await activate(mock, 'sess-tb');
      const llm = mock.hooks.get('llm_output')!;
      // single event pushes total over budget (5000)
      llm(
        { runId: 'r1', sessionId: 's1', provider: 'openai', model: 'gpt-4', assistantTexts: ['x'], usage: { input: 3000, output: 2500, total: 5500 } },
        { sessionKey: 'sess-tb' },
      );

      const finalize = mock.hooks.get('before_agent_finalize')!;
      const result = await finalize({
        sessionId: 'sid-sess-tb', sessionKey: 'sess-tb', stopHookActive: false, lastAssistantMessage: '继续工作',
      });
      expect(result.action).toBe('finalize');

      const proj = await readProjection(mock, 'sess-tb');
      expect(proj.status).toBe('paused');
      expect(proj.pauseReason).toBe('token_budget_exceeded');
      expect(proj.tokenBudget).toBe(5000);
    });
  });

  describe('pause reason: max_total_reached', () => {
    it('totalContinuations >= maxTotalContinuations pauses with max_total_reached', async () => {
      setupWithConfig({ maxTotalContinuations: 3 });
      await activate(mock, 'sess-mt');
      const finalize = mock.hooks.get('before_agent_finalize')!;
      // drive 3 revise turns to reach max (each revise increments totalContinuations)
      for (let i = 0; i < 3; i++) {
        await finalize({
          sessionId: 'sid-sess-mt', sessionKey: 'sess-mt', stopHookActive: false, lastAssistantMessage: 'working...',
        });
      }
      // next finalize hits the max guard (totalContinuations(3) >= maxTotalContinuations(3))
      const result = await finalize({
        sessionId: 'sid-sess-mt', sessionKey: 'sess-mt', stopHookActive: false, lastAssistantMessage: 'working...',
      });
      expect(result.action).toBe('finalize');

      const proj = await readProjection(mock, 'sess-mt');
      expect(proj.status).toBe('paused');
      expect(proj.pauseReason).toBe('max_total_reached');
      expect(proj.totalContinuations).toBeGreaterThanOrEqual(3);
    });
  });

  describe('pause reason: loop_breaker_triggered (agent_end path)', () => {
    it('agent_end with circuit-breaker error pauses with loop_breaker_triggered', async () => {
      await activate(mock, 'sess-lb');
      // fire before_agent_finalize first so canaryFired is set (takes the normal agent_end path
      // which checks the breaker, not the degraded path)
      const finalize = mock.hooks.get('before_agent_finalize')!;
      await finalize({
        sessionId: 'sid-sess-lb', sessionKey: 'sess-lb', stopHookActive: false, lastAssistantMessage: 'working...',
      });

      const agentEnd = mock.hooks.get('agent_end')!;
      await agentEnd({
        sessionId: 'sid-sess-lb', sessionKey: 'sess-lb', success: false,
        error: 'Tool execution failed: circuit breaker tripped',
        messages: [],
      });

      const proj = await readProjection(mock, 'sess-lb');
      expect(proj.status).toBe('paused');
      expect(proj.pauseReason).toBe('loop_breaker_triggered');
    });

    it('agent_end without circuit-breaker text does NOT pause with loop_breaker_triggered', async () => {
      await activate(mock, 'sess-lb-neg');
      const finalize = mock.hooks.get('before_agent_finalize')!;
      await finalize({
        sessionId: 'sid-sess-lb-neg', sessionKey: 'sess-lb-neg', stopHookActive: false, lastAssistantMessage: 'working...',
      });
      const agentEnd = mock.hooks.get('agent_end')!;
      await agentEnd({
        sessionId: 'sid-sess-lb-neg', sessionKey: 'sess-lb-neg', success: false,
        error: 'some other transient failure', messages: [],
      });

      const proj = await readProjection(mock, 'sess-lb-neg');
      // not paused via breaker — stays running (canary fired, breaker substring absent)
      expect(proj.pauseReason).not.toBe('loop_breaker_triggered');
    });
  });

  describe('paused projection canStop semantics', () => {
    it('paused projection reports canStop=true (projectState line 69)', async () => {
      setupWithConfig({ maxTotalContinuations: 1 });
      await activate(mock, 'sess-cs');
      const finalize = mock.hooks.get('before_agent_finalize')!;
      // one revise (totalContinuations→1), next finalize hits max-total pause
      await finalize({ sessionId: 'sid-sess-cs', sessionKey: 'sess-cs', stopHookActive: false, lastAssistantMessage: 'working...' });
      await finalize({ sessionId: 'sid-sess-cs', sessionKey: 'sess-cs', stopHookActive: false, lastAssistantMessage: 'working...' });

      const proj = await readProjection(mock, 'sess-cs');
      expect(proj.status).toBe('paused');
      // frozen to current behavior: paused is in the canStop allow-list
      expect(proj.canStop).toBe(true);
    });
  });
});
