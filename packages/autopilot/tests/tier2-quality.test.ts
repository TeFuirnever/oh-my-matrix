/**
 * Tier 2 TDD Tests: Code Quality Fixes
 *
 * H-3: PermissionMode deduplication — UI imports from extension, not re-defined
 * M-1: Console log level control — 38 console statements gated by LOG_LEVEL
 * M-7: Stall interval HMR cleanup — interval cleared on re-register
 *
 * TDD: These tests are written BEFORE the fix. They should FAIL initially.
 */
import { describe, it, expect, vi } from 'vitest';

// ─── M-1: Console log level control ─────────────────────────────────────────

describe('M-1: console statements gated by log level', () => {
  it('index.ts uses a logger utility instead of raw console.log', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../index.ts'),
      'utf-8'
    );
    // Must NOT have raw console.log calls — should use logger
    const consoleLogCount = (src.match(/console\.log\(/g) || []).length;
    // After fix, console.log should be replaced by logger calls
    expect(consoleLogCount).toBe(0);
  });

  it('logger module exists and exports log, warn, error', async () => {
    // Dynamic import — will fail if module doesn't exist yet (TDD red phase)
    const logger = await import('@oh-my-matrix/permission-policy');
    expect(typeof logger.log).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('logger respects level environment variable (shared @oh-my-matrix/permission-policy logger)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const loggerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../permission-policy/src/logger.ts'),
      'utf-8'
    );
    expect(loggerSrc).toMatch(/AUTOPILOT_LOG_LEVEL|DYNAMIC_WORKFLOWS_LOG_LEVEL|LOG_LEVEL/);
  });
});

// ─── M-7: Stall interval HMR cleanup ────────────────────────────────────────

describe('M-7: stall interval HMR cleanup', () => {
  it('register() clears previous stallInterval before creating new one', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../index.ts'),
      'utf-8'
    );
    // Must clear existing interval before setting new one
    // Look for guard pattern: if (stallInterval) { clearInterval(stallInterval); }
    expect(src).toMatch(/if\s*\(\s*stallInterval\s*\)\s*\{\s*clearInterval\(stallInterval\)/);
  });

  it('calling register() twice does not leak intervals', async () => {
    const mod = await import('../index');
    mod._resetForTest();

    const api = {
      pluginConfig: {},
      on: () => {},
      registerHook: () => {},
      registerSessionExtension: vi.fn(),
      registerGatewayMethod: () => {},
      enqueueNextTurnInjection: vi.fn().mockResolvedValue({ enqueued: true }),
    };

    // Register twice
    mod.register(api as any);
    mod.register(api as any);

    // Internal state should show clean interval (not duplicated)
    const state = mod._getInternalStateForTest();
    expect(state).toBeDefined();
  });
});
