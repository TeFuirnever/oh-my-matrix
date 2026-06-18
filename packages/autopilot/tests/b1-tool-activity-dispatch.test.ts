/**
 * B-1 TDD Tests: before_tool_call / after_tool_call must dispatch agent_activity
 *
 * Bug: tool_call / tool_result activity never dispatched through orchestratorReducer.
 * Result: lastActivityAt only updates on llm_output, so tool-intensive loops
 * (no LLM output between tool calls) can be falsely detected as stalled.
 *
 * Fix: dispatch orchestratorReducer({ type:'agent_activity', activity:'tool_call'/'tool_result' })
 * inside before_tool_call and after_tool_call hooks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _resetForTest,
  register,
} from '../index';
import type { GatewayCtx } from '../src/types';

vi.stubGlobal('window', {
  electron: { ipcRenderer: { invoke: vi.fn().mockResolvedValue({ success: true }) } },
});

function buildMockApi() {
  const hooks: Record<string, (...args: unknown[]) => unknown> = {};
  const gatewayMethods: Record<string, (ctx: GatewayCtx) => void | Promise<void>> = {};
  return {
    pluginConfig: {},
    on: (name: string, handler: (...args: unknown[]) => unknown) => { hooks[name] = handler; },
    registerHook: (name: string, handler: (...args: unknown[]) => unknown) => { hooks[name] = handler; },
    registerSessionExtension: vi.fn(),
    registerGatewayMethod: (method: string, handler: (ctx: GatewayCtx) => void | Promise<void>) => {
      gatewayMethods[method] = handler;
    },
    enqueueNextTurnInjection: vi.fn().mockResolvedValue({ enqueued: true }),
    hooks,
    gatewayMethods,
  };
}

async function getLastActivityAt(
  api: ReturnType<typeof buildMockApi>,
  sessionKey: string,
): Promise<number | undefined> {
  const respond = vi.fn();
  await api.gatewayMethods['autopilot.status']({ params: { sessionKey }, respond });
  const call = respond.mock.calls[0];
  return call?.[1]?.projection?.lastActivityAt as number | undefined;
}

describe('B-1: before_tool_call dispatches agent_activity updating lastActivityAt', () => {
  let api: ReturnType<typeof buildMockApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    api = buildMockApi();
    register(api as any);
  });

  it('before_tool_call updates lastActivityAt (stall timer must reset on tool calls)', async () => {
    const sk = 'sess-b1-before';
    await api.gatewayMethods['autopilot.activate']({
      params: { sessionKey: sk, goal: 'implement feature' },
      respond: vi.fn(),
    });

    const atActivation = await getLastActivityAt(api, sk);
    expect(atActivation).toBeDefined();

    // Wait 2ms so Date.now() will differ
    await new Promise((r) => setTimeout(r, 2));

    api.hooks['before_tool_call'](
      { toolName: 'bash', args: ['ls', '-la'], toolKind: 'execute' },
      { sessionKey: sk },
    );

    const atToolCall = await getLastActivityAt(api, sk);
    // After fix: lastActivityAt must advance past activation time
    expect(atToolCall).toBeGreaterThan(atActivation!);
  });

  it('after_tool_call (no error) updates lastActivityAt', async () => {
    const sk = 'sess-b1-after';
    await api.gatewayMethods['autopilot.activate']({
      params: { sessionKey: sk, goal: 'run tests' },
      respond: vi.fn(),
    });

    const atActivation = await getLastActivityAt(api, sk);
    expect(atActivation).toBeDefined();

    await new Promise((r) => setTimeout(r, 2));

    // after_tool_call without error (normal tool completion)
    // Note: after_tool_call reads sessionKey from event (not ctx)
    api.hooks['after_tool_call'](
      { toolName: 'bash', params: { command: 'ls' }, sessionKey: sk },
    );

    const atToolResult = await getLastActivityAt(api, sk);
    // After fix: lastActivityAt must advance past activation time
    expect(atToolResult).toBeGreaterThan(atActivation!);
  });
});
