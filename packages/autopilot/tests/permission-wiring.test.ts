import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { register, _resetForTest } from '../index';

// Hoist mock so loadWorkflowConfig can be controlled per-test for destructive_git scenarios
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

async function activateSession(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const respond = vi.fn();
  await mock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey }, respond });

  const sessionStartHandler = mock.hooks.get('session_start')!;
  await sessionStartHandler({ sessionId: `sid-${sessionKey}`, sessionKey });
}

describe('permission-wiring: decidePermission() integration', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
  });

  afterEach(() => {
    _resetForTest(); // clear stall interval so it doesn't leak into subsequent test files
  });

  describe('credential_access tool is blocked', () => {
    it('credential_access tool is hard-blocked (block: true)', async () => {
      await activateSession(mock, 'sess-perm-1');

      const beforeToolCall = mock.hooks.get('before_tool_call')!;
      const result = await beforeToolCall(
        { toolName: 'get-credential', params: {} },
        { sessionKey: 'sess-perm-1' },
      ) as any;

      // block outcome returns { block: true, blockReason } — bypasses approval channel
      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.blockReason).toBeDefined();
    });

    it('read_only tool is auto-allowed (returns undefined)', async () => {
      await activateSession(mock, 'sess-perm-2');

      const beforeToolCall = mock.hooks.get('before_tool_call')!;
      const result = await beforeToolCall(
        { toolName: 'read', params: { path: '/x' } },
        { sessionKey: 'sess-perm-2' },
      );

      // undefined means allowed (no approval needed)
      expect(result).toBeUndefined();
    });
  });

  describe('before_tool_call — wiring', () => {
    // 1. workspace_write is auto-allowed (no dialog)
    it('allows workspace_write without approval', async () => {
      await activateSession(mock, 'sess-fy-ws');

      const beforeToolCall = mock.hooks.get('before_tool_call')!;
      const result = await beforeToolCall(
        { toolName: 'write_file', params: {} },
        { sessionKey: 'sess-fy-ws' },
      );

      // allow → before_tool_call returns undefined (no approval prompt)
      expect(result).toBeUndefined();
    });

    // 2. network auto-allowed (aggressive route — P1-1)
    it('allows network commands without approval', async () => {
      await activateSession(mock, 'sess-fy-net');

      const beforeToolCall = mock.hooks.get('before_tool_call')!;
      const result = await beforeToolCall(
        { toolName: 'git', toolKind: undefined, args: ['push', 'origin', 'main'] },
        { sessionKey: 'sess-fy-net' },
      );

      // allow → before_tool_call returns undefined (no approval prompt)
      expect(result).toBeUndefined();
    });

    // 3. destructive_git + workflowAllowsDestructiveGit=true + cwd within workspace → allow
    it('allows destructive_git when workflow permits and cwd in workspace', async () => {
      const { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } =
        await import('../src/workflow-config');
      vi.mocked(loadWorkflowConfig).mockReturnValueOnce({
        config: { ...DEFAULT_WORKFLOW_CONFIG, destructiveGit: { allow: true } },
        warnings: [],
      });

      _resetForTest();
      const mockFy = createMockApi();
      register(mockFy.api as any);
      await activateSession(mockFy, 'sess-fy-dg-allow');

      const beforeToolCall = mockFy.hooks.get('before_tool_call')!;
      const result = await beforeToolCall(
        { toolName: 'exec', params: { command: 'git reset --hard HEAD~1' } },
        { sessionKey: 'sess-fy-dg-allow' },
      );

      // allow → returns undefined
      expect(result).toBeUndefined();
    });

    // 4. destructive_git + workflowAllowsDestructiveGit=false → block
    it('blocks destructive_git when workflow does not permit', async () => {
      // Default workflow config has destructiveGit.allow = false — no override needed
      await activateSession(mock, 'sess-fy-dg-block');

      const beforeToolCall = mock.hooks.get('before_tool_call')!;
      const result = await beforeToolCall(
        { toolName: 'exec', params: { command: 'git reset --hard HEAD~1' } },
        { sessionKey: 'sess-fy-dg-block' },
      ) as any;

      // block → hard veto (block: true, blockReason)
      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.blockReason).toBeDefined();
    });

    // 5. workspacePath from activate payload is used for containment: event.cwd outside workspace → block
    it('blocks destructive_git when event.cwd is outside activate workspacePath', async () => {
      const { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } =
        await import('../src/workflow-config');
      vi.mocked(loadWorkflowConfig).mockReturnValueOnce({
        config: { ...DEFAULT_WORKFLOW_CONFIG, destructiveGit: { allow: true } },
        warnings: [],
      });

      _resetForTest();
      const mockWsOut = createMockApi();
      register(mockWsOut.api as any);

      // Use process.cwd() so validateWorkspacePath accepts the path (it must exist on disk)
      const activateRespond = vi.fn();
      await mockWsOut.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: 'sess-fy-outside', workspacePath: process.cwd() }, respond: activateRespond });
      await mockWsOut.hooks.get('session_start')!({ sessionId: 'sid-sess-fy-outside', sessionKey: 'sess-fy-outside' });

      const beforeToolCall = mockWsOut.hooks.get('before_tool_call')!;
      // event.cwd is clearly outside process.cwd() → must be blocked
      const result = await beforeToolCall(
        { toolName: 'exec', params: { command: 'git reset --hard HEAD~1', workdir: '/tmp/completely-different-path-not-in-workspace' } },
        { sessionKey: 'sess-fy-outside' },
      ) as any;

      // block → hard veto (block: true, blockReason)
      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.blockReason).toBeDefined();
    });

    // 6. workspacePath from activate: event.cwd within workspace → allow
    it('allows destructive_git when event.cwd is within activate workspacePath', async () => {
      const { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } =
        await import('../src/workflow-config');
      vi.mocked(loadWorkflowConfig).mockReturnValueOnce({
        config: { ...DEFAULT_WORKFLOW_CONFIG, destructiveGit: { allow: true } },
        warnings: [],
      });

      _resetForTest();
      const mockWsIn = createMockApi();
      register(mockWsIn.api as any);

      // Use process.cwd() so validateWorkspacePath accepts the path
      const activateRespond = vi.fn();
      await mockWsIn.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: 'sess-fy-inside', workspacePath: process.cwd() }, respond: activateRespond });
      await mockWsIn.hooks.get('session_start')!({ sessionId: 'sid-sess-fy-inside', sessionKey: 'sess-fy-inside' });

      const beforeToolCall = mockWsIn.hooks.get('before_tool_call')!;
      // event.cwd equals workspacePath exactly → must be allowed
      const result = await beforeToolCall(
        { toolName: 'exec', params: { command: 'git reset --hard HEAD~1', workdir: process.cwd() } },
        { sessionKey: 'sess-fy-inside' },
      );

      // allow → undefined
      expect(result).toBeUndefined();
    });

    // 7. credential_access is unconditionally blocked in all modes
    it('blocks credential_access unconditionally', async () => {
      await activateSession(mock, 'sess-fy-cred');

      const beforeToolCall = mock.hooks.get('before_tool_call')!;
      const result = await beforeToolCall(
        { toolName: 'get-credential', params: {} },
        { sessionKey: 'sess-fy-cred' },
      ) as any;

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.blockReason).toBeDefined();
    });
  });

  describe('applyWorkflowConfig — uses validated payloadWorkspacePath (security)', () => {
    it('calls loadWorkflowConfig with undefined when workspacePath fails validation (non-existent path)', async () => {
      const { loadWorkflowConfig } = await import('../src/workflow-config');
      vi.mocked(loadWorkflowConfig).mockClear();

      _resetForTest();
      const mockApwc = createMockApi();
      register(mockApwc.api as any);

      // Activate with a path that does NOT exist on disk → validateWorkspacePath returns undefined
      const activateRespond = vi.fn();
      await mockApwc.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: 'sess-apwc-invalid', workspacePath: '/nonexistent/malicious/path' }, respond: activateRespond });

      // loadWorkflowConfig must have been called with undefined as 2nd arg, NOT the raw malicious path
      expect(vi.mocked(loadWorkflowConfig)).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
      );
    });

    it('calls loadWorkflowConfig with the validated path when workspacePath is a real directory', async () => {
      const { loadWorkflowConfig } = await import('../src/workflow-config');
      vi.mocked(loadWorkflowConfig).mockClear();

      _resetForTest();
      const mockApwc2 = createMockApi();
      register(mockApwc2.api as any);

      // process.cwd() is a real directory → validateWorkspacePath passes it through
      const activateRespond = vi.fn();
      await mockApwc2.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey: 'sess-apwc-valid', workspacePath: process.cwd() }, respond: activateRespond });

      expect(vi.mocked(loadWorkflowConfig)).toHaveBeenCalledWith(
        expect.any(String),
        process.cwd(),
      );
    });
  });
});
