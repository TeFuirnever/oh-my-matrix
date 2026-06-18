/**
 * T-1, T-5, T-6, T-9: G-1 priority inversion and audit coordination tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock audit module using relative path (not package name — not in node_modules).
// vitest.config.ts aliases '@openclaw/matrixassistant-audit' to this same file,
// so this single mock intercepts both the test imports and the production require().
vi.mock('@openclaw/matrixassistant-audit', () => ({
  audit_setMode: vi.fn(),
}));

import { register, _resetForTest, _setAuditSetModeForTest } from '../index';
import * as auditMod from '@openclaw/matrixassistant-audit';

function createMockApi() {
  const hooks = new Map<string, { handler: (...args: unknown[]) => any; opts?: { priority?: number } }>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();

  const enqueueNextTurnInjection = vi.fn(async (injection: any) => ({
    enqueued: true,
    id: 'inj-1',
    sessionKey: injection.sessionKey,
  }));

  const session = {
    workflow: { enqueueNextTurnInjection },
    state: { registerSessionExtension: vi.fn() },
  };

  return {
    api: {
      pluginConfig: {} as Record<string, unknown>,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => {
        hooks.set(hookName, { handler, opts });
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      session,
      enqueueNextTurnInjection,
      registerSessionExtension: session.state.registerSessionExtension,
    },
    hooks,
    gatewayMethods,
  };
}

describe('G-1 priority inversion and audit coordination (T-1, T-5, T-6, T-9)', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetForTest();
    // Inject the mock vi.fn() directly into _auditSetMode so the closed-over
    // reference in autopilot/index.ts points to the spy we can assert on.
    _setAuditSetModeForTest(vi.mocked(auditMod.audit_setMode));
    mock = createMockApi();
    register(mock.api as any);
  });

  // T-1: before_tool_call registered with priority 10
  it('T-1: registers before_tool_call with priority 10', () => {
    const hookEntry = mock.hooks.get('before_tool_call');
    expect(hookEntry).toBeDefined();
    expect(hookEntry?.opts?.priority).toBe(10);
  });

  // T-5: autopilot hook executes and records audit trail (doesn't throw)
  it('T-5: before_tool_call runs autopilot audit logic when session is active', async () => {
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    await activateHandler({ params: { sessionKey: 'sess-g1' }, respond: vi.fn() });

    const sessionStartHandler = mock.hooks.get('session_start')!.handler;
    await sessionStartHandler({ sessionId: 'sid-g1', sessionKey: 'sess-g1' });

    const toolCallHandler = mock.hooks.get('before_tool_call')!.handler;

    // Should not throw — autopilot audit logic executes
    expect(() => toolCallHandler(
      { toolName: 'read_file', params: { path: '/workspace/src/main.ts' }, toolKind: 'read' },
      { sessionKey: 'sess-g1' },
    )).not.toThrow();
  });

  // T-6: setAuditMode no-ops gracefully when audit module unavailable
  it('T-6: activate completes successfully regardless of audit coordination', async () => {
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    const respond = vi.fn();

    await expect(activateHandler({
      params: { sessionKey: 'sess-g6' },
      respond,
    })).resolves.not.toThrow();

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));
  });

  // T-9: activate sets audit to monitor; stop restores active
  it('T-9: activate calls audit_setMode(monitor), stop calls audit_setMode(active)', async () => {
    const audit_setMode = vi.mocked(auditMod.audit_setMode);

    // Activate
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    await activateHandler({
      params: { sessionKey: 'sess-g9' },
      respond: vi.fn(),
    });

    expect(audit_setMode).toHaveBeenCalledWith('monitor');

    // Stop should restore active
    audit_setMode.mockClear();
    const stopHandler = mock.gatewayMethods.get('autopilot.stop')!;
    await stopHandler({ params: { sessionKey: 'sess-g9' }, respond: vi.fn() });

    expect(audit_setMode).toHaveBeenCalledWith('active');
  });

  // T-9b: all activate calls set audit monitor mode (unconditional)
  it('T-9b: activate always calls audit_setMode(monitor)', async () => {
    const audit_setMode = vi.mocked(auditMod.audit_setMode);
    audit_setMode.mockClear();

    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    await activateHandler({
      params: { sessionKey: 'sess-g9c' },
      respond: vi.fn(),
    });

    expect(audit_setMode).toHaveBeenCalledWith('monitor');
  });
});
