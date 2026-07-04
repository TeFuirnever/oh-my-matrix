/**
 * S10: token budget silently no-ops when the host doesn't report token usage.
 *
 * When event.usage is absent, the llm_output hook returned early without any
 * warning, so totalTokensUsed never advanced and the configured tokenBudget
 * was never enforced — a silent no-op invisible to operators. This test
 * proves the fix: a one-shot warn fires when usage is absent AND a tokenBudget
 * is configured.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { register, _resetForTest } from '../index';
import type { GatewayCtx } from '../src/types';

function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const gatewayMethods = new Map<string, (ctx: GatewayCtx) => void | Promise<void>>();

  const enqueueNextTurnInjection = async (injection: any) => ({
    enqueued: true,
    id: `inj-1`,
    sessionKey: injection.sessionKey,
  });
  const registerSessionExtension = (_ext: any) => {};

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
  };
}

describe('S10: token budget silent no-op when host omits usage', () => {
  let mock: ReturnType<typeof createMockApi>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('warns when usage is absent and a tokenBudget is configured', async () => {
    // Activate a run WITH a tokenBudget
    const activate = mock.gatewayMethods.get('autopilot.activate')!;
    await activate({
      params: { sessionKey: 'sess-s10', tokenBudget: 10000 },
      respond: vi.fn(),
    } as any);

    warnSpy.mockClear();

    // Fire an llm_output event with NO usage field
    const llmOutput = mock.hooks.get('llm_output')!;
    llmOutput(
      { /* no usage */ } as any,
      { sessionKey: 'sess-s10' } as any,
    );

    // S10: a warning must surface so operators know the budget isn't enforced
    const warned = warnSpy.mock.calls.some(
      (c) => typeof c[0] === 'string' && /usage|token/i.test(c[0]),
    );
    expect(warned).toBe(true);
  });

  it('does NOT warn when usage is absent but no tokenBudget is configured', async () => {
    // Activate a run WITHOUT a tokenBudget — budget enforcement is irrelevant
    const activate = mock.gatewayMethods.get('autopilot.activate')!;
    await activate({
      params: { sessionKey: 'sess-s10-nobudget' },
      respond: vi.fn(),
    } as any);

    warnSpy.mockClear();

    const llmOutput = mock.hooks.get('llm_output')!;
    llmOutput(
      { /* no usage */ } as any,
      { sessionKey: 'sess-s10-nobudget' } as any,
    );

    const budgetWarnings = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /usage|token/i.test(c[0]),
    );
    expect(budgetWarnings).toHaveLength(0);
  });

  it('warns only ONCE per run (no log spam across multiple absent-usage events)', async () => {
    const activate = mock.gatewayMethods.get('autopilot.activate')!;
    await activate({
      params: { sessionKey: 'sess-s10-once', tokenBudget: 10000 },
      respond: vi.fn(),
    } as any);

    const llmOutput = mock.hooks.get('llm_output')!;

    // Fire 5 absent-usage events without clearing the spy
    for (let i = 0; i < 5; i++) {
      llmOutput({} as any, { sessionKey: 'sess-s10-once' } as any);
    }

    const budgetWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /host did not report/i.test(c[0]),
    );
    expect(budgetWarns.length).toBe(1); // exactly once, not 5 times
  });
});
