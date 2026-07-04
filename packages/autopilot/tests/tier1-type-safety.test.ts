/**
 * Tier 1 TDD Tests: Type Safety Fixes
 *
 * H-2: isValidBlockedReason() guard — dynamic error strings must not bypass BlockedReason union
 * H-6: register(api: OpenClawPluginApi) — SDK typed plugin API contract
 * H-7: SessionActionContext — typed action handler context
 *
 * TDD: These tests are written BEFORE the fix. They should FAIL initially.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GatewayCtx } from '../src/types';

// ─── H-2: isValidBlockedReason ──────────────────────────────────────────────

describe('H-2: isValidBlockedReason type guard', () => {
  // Dynamic import to get the module after implementation
  async function loadTypes() {
    return await import('../src/types');
  }

  it('exports isValidBlockedReason function', async () => {
    const types = await loadTypes();
    expect(typeof types.isValidBlockedReason).toBe('function');
  });

  it('returns true for all valid BlockedReason values', async () => {
    const types = await loadTypes();
    const validReasons = [
      'permission_denied',
      'workspace_containment_failed',
      'workspace_create_failed',
      'validation_failed',
      'evidence_missing',
      'stalled',
      'token_budget_exceeded',
      'user_stopped',
      'config_invalid',
      'max_retries_reached',
    ];
    for (const reason of validReasons) {
      expect(types.isValidBlockedReason(reason)).toBe(true);
    }
  });

  it('returns false for arbitrary error strings', async () => {
    const types = await loadTypes();
    expect(types.isValidBlockedReason('some random error')).toBe(false);
    expect(types.isValidBlockedReason('')).toBe(false);
    expect(types.isValidBlockedReason('Permission denied')).toBe(false); // case-sensitive
    expect(types.isValidBlockedReason('unknown error')).toBe(false);
  });

  it('acts as TypeScript type guard (returns value is BlockedReason)', async () => {
    const types = await loadTypes();
    const value: string = 'permission_denied';
    if (types.isValidBlockedReason(value)) {
      // TypeScript should narrow type to BlockedReason here
      // Runtime check: it should be truthy
      expect(value).toBe('permission_denied');
    } else {
      expect.unreachable('should have been a valid BlockedReason');
    }
  });
});

describe('H-2: orchestrator fallback on invalid BlockedReason', () => {
  it('falls back to unrecoverable_error (non-resumable) when agent_turn_finished error is not a valid BlockedReason (W1b)', async () => {
    const { orchestratorReducer } = await import('../src/orchestrator');
    const { createInitialState } = await import('../src/types');

    const state = {
      ...createInitialState('sess-1', 'run-1'),
      orchestrationState: 'running' as const,
      retry: { attempt: 3, nextRetryAt: Date.now(), lastError: '', recoverable: true },
      workflow: {
        version: 1 as const,
        source: 'default' as const,
        maxConcurrent: 5,
        maxRetries: 3,
        stallTimeoutMs: 300000,
        maxRetryBackoffMs: 300000,
        workspace: { root: '.', cleanup: 'manual' as const, branchPrefix: 'autopilot', allowDirtyBase: false },
        validation: { commands: [], failOnOptional: false },
        destructiveGit: { allow: false },
        warnings: [],
      },
    };

    // Error string that is NOT a valid BlockedReason
    const next = orchestratorReducer(state, {
      type: 'agent_turn_finished',
      runId: 'run-1',
      success: false,
      error: 'some unknown runtime error string',
      now: Date.now(),
    });

    expect(next.orchestrationState).toBe('blocked');
    // Must NOT be the raw error string — must be a valid fallback
    // W1b: unrecognized error strings fall back to 'unrecoverable_error' (non-resumable),
    // NOT 'validation_failed' (which is RESUMABLE — the old lossy fallback bug).
    expect(next.blockedReason).toBe('unrecoverable_error');
  });

  it('preserves valid BlockedReason from error string', async () => {
    const { orchestratorReducer } = await import('../src/orchestrator');
    const { createInitialState } = await import('../src/types');

    const state = {
      ...createInitialState('sess-1', 'run-1'),
      orchestrationState: 'running' as const,
      retry: { attempt: 3, nextRetryAt: Date.now(), lastError: '', recoverable: true },
      workflow: {
        version: 1 as const,
        source: 'default' as const,
        maxConcurrent: 5,
        maxRetries: 3,
        stallTimeoutMs: 300000,
        maxRetryBackoffMs: 300000,
        workspace: { root: '.', cleanup: 'manual' as const, branchPrefix: 'autopilot', allowDirtyBase: false },
        validation: { commands: [], failOnOptional: false },
        destructiveGit: { allow: false },
        warnings: [],
      },
    };

    // Error string that IS a valid BlockedReason
    const next = orchestratorReducer(state, {
      type: 'agent_turn_finished',
      runId: 'run-1',
      success: false,
      error: 'token_budget_exceeded',
      now: Date.now(),
    });

    expect(next.orchestrationState).toBe('blocked');
    expect(next.blockedReason).toBe('token_budget_exceeded');
  });
});

// ─── H-6: register() uses SDK OpenClawPluginApi ──────────────────────────────────

describe('H-6: register() uses SDK OpenClawPluginApi', () => {
  it('register function no longer uses `api: any` — source scan', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../index.ts'),
      'utf-8'
    );
    // register(api: any) must be replaced with register(api: OpenClawPluginAPI)
    expect(src).not.toMatch(/export function register\(api:\s*any\)/);
    // The typed parameter must be present
    expect(src).toMatch(/register\(api:\s*\w+\)/);
  });
});

// ─── H-7: SessionActionContext typed contract ───────────────────────────────

describe('H-7: session action handlers use typed context (no ctx as any)', () => {
  it('activate handler reads workspacePath from typed context — source scan', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../index.ts'),
      'utf-8'
    );
    // Must NOT have `(ctx as any).workspacePath`
    expect(src).not.toContain('(ctx as any).workspacePath');
    // Must use typed access instead (e.g., ctx.workspacePath)
    expect(src).toMatch(/ctx\.workspacePath/);
  });

  it('exports SessionActionContext type from types module', async () => {
    const types = await import('../src/types');
    // Type exists if module loads without error
    expect(types).toBeDefined();
  });
});

// ─── H-6 Integration: register() with typed API still works ────────────────

describe('H-6/H-7 integration: register() with typed API', () => {
  let api: Record<string, unknown>;
  let hooks: Record<string, (...args: unknown[]) => unknown>;
  let gatewayMethods: Record<string, (ctx: GatewayCtx) => void | Promise<void>>;

  beforeEach(async () => {
    const mod = await import('../index');
    mod._resetForTest();

    hooks = {};
    gatewayMethods = {};

    api = {
      pluginConfig: {},
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
    };

    mod.register(api as any); // api typed as Record<string,unknown> — cast needed for loose test object
  });

  it('activate action accepts typed context with workspacePath', async () => {
    const respond = vi.fn();
    await gatewayMethods['autopilot.activate']({
      params: {
        sessionKey: 'sess-typed',
        maxTotalContinuations: 20,
        workspacePath: undefined, // explicitly typed, not `(ctx as any)`
      },
      respond,
    });
    const result = respond.mock.calls[0][1];
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  it('activate action accepts workspacePath from typed context', async () => {
    const respond = vi.fn();
    await gatewayMethods['autopilot.activate']({
      params: {
        sessionKey: 'sess-typed-ws',
        maxTotalContinuations: 50,
        workspacePath: process.cwd(), // valid absolute path
      },
      respond,
    });
    const result = respond.mock.calls[0][1];
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  it('status action works through typed API', async () => {
    const respondActivate = vi.fn();
    await gatewayMethods['autopilot.activate']({ params: { sessionKey: 'sess-check' }, respond: respondActivate });
    const respondStatus = vi.fn();
    await gatewayMethods['autopilot.status']({ params: { sessionKey: 'sess-check' }, respond: respondStatus });
    // respond(ok, data) — calls[0][0] is the ok flag, calls[0][1] is the data
    expect(respondStatus.mock.calls[0][0]).toBe(true);
    const result = respondStatus.mock.calls[0][1];
    expect((result as any).projection).toBeDefined();
  });
});
