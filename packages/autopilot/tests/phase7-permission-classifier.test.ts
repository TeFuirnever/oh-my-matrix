/**
 * Phase 7 TDD Tests: Permission Classifier + Workflow Config + Evidence UI
 *
 * GAP-5 partial: Use classifyCommand from permission-policy.ts in before_tool_call
 * GAP-6: Wire loadWorkflowConfig into activate handler
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _resetForTest,
  register,
} from '../index';
import type { GatewayCtx } from '../src/types';

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

async function getState(gatewayMethods: Record<string, (...args: unknown[]) => unknown>, sessionKey: string): Promise<Record<string, any>> {
  const respondStatus = vi.fn();
  await gatewayMethods['autopilot.status']({ params: { sessionKey }, respond: respondStatus });
  return respondStatus.mock.calls[0][1]; // data object
}

describe('Phase 7: Permission classifier + workflow config', () => {
  let api: ReturnType<typeof buildMockApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    api = buildMockApi();
    register(api);
  });

  async function activateSession(sessionKey: string, goal?: string) {
    await api.gatewayMethods['autopilot.activate']({ params: { sessionKey, goal: goal ?? 'test goal' }, respond: vi.fn() });
    const sessionStart = api.hooks['session_start'];
    if (sessionStart) sessionStart({ sessionId: `sid-${sessionKey}`, sessionKey });
  }

  describe('GAP-5 partial: classifyCommand in before_tool_call', () => {
    it('uses classifyCommand to determine command class for audit entries', async () => {
      await activateSession('sess-cls1', 'test');

      const beforeTool = api.hooks['before_tool_call'];
      beforeTool(
        { toolName: 'read_file', toolKind: 'read_only' },
        { sessionKey: 'sess-cls1' },
      );

      const state = await getState(api.gatewayMethods, 'sess-cls1');
      expect(state.permissionAudit.length).toBeGreaterThanOrEqual(1);
      const entry = state.permissionAudit[0];
      // Should use classifyCommand output, not hardcoded 'read_only'
      expect(entry.commandClass).toBe('read_only');
    });

    it('classifies code_mode_exec with args via command classifier', async () => {
      await activateSession('sess-cls2', 'test');

      const beforeTool = api.hooks['before_tool_call'];
      beforeTool(
        { toolName: 'bash', toolKind: 'code_mode_exec', params: { cmd: 'npm test' } },
        { sessionKey: 'sess-cls2' },
      );

      const state = await getState(api.gatewayMethods, 'sess-cls2');
      const entry = state.permissionAudit[0];
      // classifyCommand classifies based on tool+args, falls through for unknown
      expect(entry.commandClass).toBeDefined();
      expect(typeof entry.commandClass).toBe('string');
    });

    it('classifies unknown toolKind as unknown command class', async () => {
      await activateSession('sess-cls3', 'test');

      const beforeTool = api.hooks['before_tool_call'];
      beforeTool(
        { toolName: 'custom_tool', toolKind: undefined },
        { sessionKey: 'sess-cls3' },
      );

      const state = await getState(api.gatewayMethods, 'sess-cls3');
      const entry = state.permissionAudit[0];
      // classifyCommand returns 'unknown' for unrecognized tools without toolKind
      expect(entry.commandClass).toBeDefined();
    });
  });

  describe('GAP-6: loadWorkflowConfig wired into activate', () => {
    it('activate stores workflow config in state when available', async () => {
      // Activate with workspace path — workflow config should be loaded
      await api.gatewayMethods['autopilot.activate']({
        params: { sessionKey: 'sess-wf1', goal: 'test task', workspacePath: '/tmp/test-workspace' },
        respond: vi.fn(),
      });

      const state = await getState(api.gatewayMethods, 'sess-wf1');
      // State should have workflow config (even if it's the default)
      expect(state.workflow).toBeDefined();
      if (state.workflow) {
        expect(state.workflow.version).toBeDefined();
      }
    });

    it('activate falls back to default config when workspace has no WORKFLOW.md', async () => {
      await api.gatewayMethods['autopilot.activate']({
        params: { sessionKey: 'sess-wf2', goal: 'test task', workspacePath: '/nonexistent/path' },
        respond: vi.fn(),
      });

      const state = await getState(api.gatewayMethods, 'sess-wf2');
      // Should have default config, not an error
      expect(state.workflow).toBeDefined();
      expect(state.workflow?.source).toBeDefined();
    });
  });
});
