/**
 * Phase 6 TDD Tests: Backend Module Wiring
 *
 * GAP-8:  progress field written on agent_turn_finished
 * GAP-9:  PermissionAuditEntry logged on before_tool_call decisions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _resetForTest,
  register,
} from '../index';
import type { GatewayCtx } from '../src/types';

interface ActionResult {
  ok: boolean;
  result?: Record<string, any>;
  error?: string;
}

function buildMockApi(overrides?: Record<string, unknown>) {
  const hooks: Record<string, (...args: unknown[]) => unknown> = {};
  const gatewayMethods: Record<string, (ctx: GatewayCtx) => void | Promise<void>> = {};

  return {
    pluginConfig: { maxConcurrentAutopilot: 200, ...overrides },
    on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
      hooks[hookName] = handler;
    },
    registerHook: (hookName: string, handler: (...args: unknown[]) => unknown) => {
      hooks[hookName] = handler;
    },
    registerSessionExtension: vi.fn(),
    registerGatewayMethod: (method: string, handler: (ctx: GatewayCtx) => void | Promise<void>) => {
      gatewayMethods[method] = handler;
    },
    enqueueNextTurnInjection: vi.fn().mockResolvedValue({ enqueued: true }),
    hooks,
    gatewayMethods,
  };
}

/** Get state from status action with proper typing */
async function getState(gatewayMethods: Record<string, (ctx: GatewayCtx) => void | Promise<void>>, sessionKey: string): Promise<Record<string, any>> {
  const respond = vi.fn();
  await gatewayMethods['autopilot.status']({ params: { sessionKey }, respond });
  const result = respond.mock.calls[0]?.[1] as ActionResult | undefined;
  return result ?? {};
}

describe('Phase 6: Backend module wiring', () => {
  let api: ReturnType<typeof buildMockApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    api = buildMockApi();
    register(api);
  });

  // Helper: activate a session and register sessionKey mapping
  async function activateSession(sessionKey: string, goal?: string) {
    await api.gatewayMethods['autopilot.activate']({ params: { sessionKey, goal: goal ?? 'test goal' }, respond: vi.fn() });
    const sessionStart = api.hooks['session_start'];
    if (sessionStart) sessionStart({ sessionId: `sid-${sessionKey}`, sessionKey });
  }

  describe('GAP-8: progress field written on agent_turn_finished', () => {
    it('writes progress string after agent_end with canary fired', async () => {
      await activateSession('sess-prog1', 'fix all errors');

      const prepare = api.hooks['agent_turn_prepare'];
      prepare({ prompt: 'start fixing' }, { sessionKey: 'sess-prog1' });

      const finalize = api.hooks['before_agent_finalize'];
      await finalize({
        sessionId: 'sid-sess-prog1',
        sessionKey: 'sess-prog1',
        lastAssistantMessage: 'fixed 3 files',
        stopHookActive: false,
      });

      const agentEnd = api.hooks['agent_end'];
      await agentEnd({
        sessionId: 'sid-sess-prog1',
        sessionKey: 'sess-prog1',
        success: true,
      });

      const state = await getState(api.gatewayMethods, 'sess-prog1');
      expect(state.progress).toBeDefined();
      expect(typeof state.progress).toBe('string');
      expect(state.progress.length).toBeGreaterThan(0);
    });

    it('progress includes turn count information', async () => {
      await activateSession('sess-prog2', 'refactor module');

      const prepare = api.hooks['agent_turn_prepare'];
      const finalize = api.hooks['before_agent_finalize'];
      const agentEnd = api.hooks['agent_end'];

      prepare({ prompt: 'start' }, { sessionKey: 'sess-prog2' });
      await finalize({
        sessionId: 'sid-sess-prog2',
        sessionKey: 'sess-prog2',
        lastAssistantMessage: 'working',
        stopHookActive: false,
      });
      await agentEnd({
        sessionId: 'sid-sess-prog2',
        sessionKey: 'sess-prog2',
        success: true,
      });

      const state = await getState(api.gatewayMethods, 'sess-prog2');
      expect(state.progress).toBeDefined();
      expect(state.progress).toMatch(/turn|continuation|完成/i);
    });

    it('progress is injected into agent_turn_prepare context', async () => {
      await activateSession('sess-prog3', 'build API');

      const prepare = api.hooks['agent_turn_prepare'];
      const finalize = api.hooks['before_agent_finalize'];
      const agentEnd = api.hooks['agent_end'];

      // Turn 1: write progress
      prepare({ prompt: 'start' }, { sessionKey: 'sess-prog3' });
      await finalize({
        sessionId: 'sid-sess-prog3',
        sessionKey: 'sess-prog3',
        lastAssistantMessage: 'done with first part',
        stopHookActive: false,
      });
      await agentEnd({
        sessionId: 'sid-sess-prog3',
        sessionKey: 'sess-prog3',
        success: true,
      });

      // Turn 2: agent_turn_prepare should inject progress
      const result = prepare({ prompt: 'continue' }, { sessionKey: 'sess-prog3' }) as { appendContext?: string };
      expect(result).toBeDefined();
      expect(result.appendContext).toContain('Progress so far');
    });
  });

  describe('GAP-9: PermissionAuditEntry logged on before_tool_call', () => {
    it('logs block decision for credential_access tools', async () => {
      await activateSession('sess-audit1', 'deploy app');

      const beforeTool = api.hooks['before_tool_call'];
      beforeTool(
        { toolName: 'get-credential', toolKind: 'credential_access', args: [] },
        { sessionKey: 'sess-audit1' },
      );

      const state = await getState(api.gatewayMethods, 'sess-audit1');
      expect(state.permissionAudit).toBeDefined();
      expect(state.permissionAudit.length).toBeGreaterThanOrEqual(1);

      const entry = state.permissionAudit[0];
      expect(entry.toolName).toBe('get-credential');
      expect(entry.outcome).toBe('block');
      expect(entry.commandClass).toBeDefined();
      expect(typeof entry.at).toBe('number');
      expect(entry.runId).toBeDefined();
    });

    it('logs allow decision for non-restricted tools', async () => {
      await activateSession('sess-audit2', 'read files');

      const beforeTool = api.hooks['before_tool_call'];
      beforeTool(
        { toolName: 'read_file', toolKind: 'read' },
        { sessionKey: 'sess-audit2' },
      );

      const state = await getState(api.gatewayMethods, 'sess-audit2');
      expect(state.permissionAudit).toBeDefined();
      expect(state.permissionAudit.length).toBeGreaterThanOrEqual(1);

      const entry = state.permissionAudit[state.permissionAudit.length - 1];
      expect(entry.toolName).toBe('read_file');
      expect(entry.outcome).toBe('allow');
    });

    it('logs block decision for high-risk configured tools', async () => {
      _resetForTest();
      const customApi = buildMockApi({ highRiskTools: ['dangerous_tool'] });
      register(customApi as any);
      await customApi.gatewayMethods['autopilot.activate']({ params: { sessionKey: 'sess-audit3', goal: 'test' }, respond: vi.fn() });
      const sessionStart = customApi.hooks['session_start'];
      sessionStart({ sessionId: 'sid-audit3', sessionKey: 'sess-audit3' });

      const beforeTool = customApi.hooks['before_tool_call'];
      beforeTool(
        { toolName: 'dangerous_tool', toolKind: 'custom' },
        { sessionKey: 'sess-audit3' },
      );

      const state = await getState(customApi.gatewayMethods, 'sess-audit3');
      expect(state.permissionAudit.length).toBeGreaterThanOrEqual(1);
      const entry = state.permissionAudit[0];
      expect(entry.toolName).toBe('dangerous_tool');
      expect(entry.outcome).toBe('block');
    });

    it('accumulates multiple audit entries', async () => {
      await activateSession('sess-audit4', 'multi-step');

      const beforeTool = api.hooks['before_tool_call'];
      beforeTool({ toolName: 'read', toolKind: 'read' }, { sessionKey: 'sess-audit4' });
      beforeTool({ toolName: 'bash', toolKind: 'code_mode_exec' }, { sessionKey: 'sess-audit4' });
      beforeTool({ toolName: 'write', toolKind: 'write' }, { sessionKey: 'sess-audit4' });

      const state = await getState(api.gatewayMethods, 'sess-audit4');
      expect(state.permissionAudit.length).toBe(3);
    });
  });
});
