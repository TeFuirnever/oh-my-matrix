/**
 * Phase 4 TDD Tests: Production Hardening
 *
 * GAP-25: Map LRU limit — evict least-recently-active runs when Map exceeds MAX_RUN_STATES
 * GAP-23: Cleanup on shutdown — clear all Maps + intervals
 * GAP-26: Health check — detect and clean up orphaned sessions
 * GAP-27: Cross-turn pending set race — clear after send completes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _resetForTest,
  register,
} from '../index';
import type { GatewayCtx } from '../src/types';

vi.stubGlobal('window', {
  electron: { ipcRenderer: { invoke: vi.fn().mockResolvedValue({ ok: true }) } },
});

function buildMockApi() {
  const hooks: Record<string, (...args: unknown[]) => unknown> = {};
  const gatewayMethods: Record<string, (ctx: GatewayCtx) => void | Promise<void>> = {};

  return {
    // High concurrency limit to allow LRU testing beyond default 5
    pluginConfig: { maxConcurrentAutopilot: 200 },
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

describe('Phase 4: Production hardening', () => {
  let api: ReturnType<typeof buildMockApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    api = buildMockApi();
    register(api as any);
  });

  describe('GAP-25: Map LRU limit', () => {
    it('evicts oldest run when activating beyond MAX_RUN_STATES', async () => {
      // Activate MAX+1 sessions — oldest should be evicted
      const MAX = 50; // Default max
      for (let i = 0; i <= MAX; i++) {
        await api.gatewayMethods['autopilot.activate']({ params: { sessionKey: `sess-${i}`, goal: `task ${i}` }, respond: vi.fn() });
      }

      // First session (sess-0) should have been evicted — projection is undefined
      const respondOldest = vi.fn();
      await api.gatewayMethods['autopilot.status']({ params: { sessionKey: 'sess-0' }, respond: respondOldest });
      const oldest = respondOldest.mock.calls[0][1];
      expect(oldest?.projection).toBeUndefined();

      // Latest session should still exist
      const respondLatest = vi.fn();
      await api.gatewayMethods['autopilot.status']({ params: { sessionKey: `sess-${MAX}` }, respond: respondLatest });
      const latest = respondLatest.mock.calls[0][1];
      expect(latest?.projection).toBeDefined();
    });

    it('keeps all sessions under the limit', async () => {
      // Activate fewer than MAX sessions — none evicted
      for (let i = 0; i < 10; i++) {
        await api.gatewayMethods['autopilot.activate']({ params: { sessionKey: `sess-${i}`, goal: `task ${i}` }, respond: vi.fn() });
      }

      // All should still exist
      for (let i = 0; i < 10; i++) {
        const respondS = vi.fn();
        await api.gatewayMethods['autopilot.status']({ params: { sessionKey: `sess-${i}` }, respond: respondS });
        const s = respondS.mock.calls[0][1];
        expect(s?.projection).toBeDefined();
      }
    });

    it('evicts multiple runs when far over limit', async () => {
      const MAX = 50;
      // Activate MAX + 10 sessions
      for (let i = 0; i < MAX + 10; i++) {
        await api.gatewayMethods['autopilot.activate']({ params: { sessionKey: `sess-${i}`, goal: `task ${i}` }, respond: vi.fn() });
      }

      // First 10 should be evicted
      for (let i = 0; i < 10; i++) {
        const respondS = vi.fn();
        await api.gatewayMethods['autopilot.status']({ params: { sessionKey: `sess-${i}` }, respond: respondS });
        const s = respondS.mock.calls[0][1];
        expect(s?.projection).toBeUndefined();
      }

      // Last 50 should exist
      for (let i = 10; i < MAX + 10; i++) {
        const respondS = vi.fn();
        await api.gatewayMethods['autopilot.status']({ params: { sessionKey: `sess-${i}` }, respond: respondS });
        const s = respondS.mock.calls[0][1];
        expect(s?.projection).toBeDefined();
      }
    });
  });

  describe('GAP-23: Cleanup on shutdown', () => {
    it('cleanup action clears all run state', async () => {
      // Activate some sessions
      await api.gatewayMethods['autopilot.activate']({ params: { sessionKey: 'sess-a', goal: 'task a' }, respond: vi.fn() });
      await api.gatewayMethods['autopilot.activate']({ params: { sessionKey: 'sess-b', goal: 'task b' }, respond: vi.fn() });

      // Verify they exist
      const respondSa = vi.fn();
      await api.gatewayMethods['autopilot.status']({ params: { sessionKey: 'sess-a' }, respond: respondSa });
      const sa = respondSa.mock.calls[0][1];
      expect(sa?.projection).toBeDefined();

      // Call cleanup
      const respondCleanup = vi.fn();
      await api.gatewayMethods['autopilot.cleanup']({ params: {}, respond: respondCleanup });

      // All should be gone — projection undefined means evicted
      const respondAfterA = vi.fn();
      await api.gatewayMethods['autopilot.status']({ params: { sessionKey: 'sess-a' }, respond: respondAfterA });
      const afterA = respondAfterA.mock.calls[0][1];

      const respondAfterB = vi.fn();
      await api.gatewayMethods['autopilot.status']({ params: { sessionKey: 'sess-b' }, respond: respondAfterB });
      const afterB = respondAfterB.mock.calls[0][1];

      expect(afterA?.projection).toBeUndefined();
      expect(afterB?.projection).toBeUndefined();
    });

    it('cleanup action returns ok', async () => {
      const respondCleanup = vi.fn();
      await api.gatewayMethods['autopilot.cleanup']({ params: {}, respond: respondCleanup });
      expect(respondCleanup.mock.calls[0][0]).toBe(true);
    });
  });

  describe('GAP-26: Orphaned session health check', () => {
    let healthApi: ReturnType<typeof buildMockApi>;

    beforeEach(() => {
      vi.useFakeTimers();
      _resetForTest();
      healthApi = buildMockApi();
      register(healthApi as any); // Register with fake timers active
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('cleans up sessions with no activity beyond health check threshold', async () => {
      // Activate a session
      await healthApi.gatewayMethods['autopilot.activate']({ params: { sessionKey: 'sess-orphan', goal: 'stale task' }, respond: vi.fn() });

      // Verify it exists
      const respondBefore = vi.fn();
      await healthApi.gatewayMethods['autopilot.status']({ params: { sessionKey: 'sess-orphan' }, respond: respondBefore });
      const before = respondBefore.mock.calls[0][1];
      expect(before?.projection).toBeDefined();

      // Advance time well past the orphan threshold (24h) + 1 stall check interval
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 60_000);

      // After health check interval fires, orphaned session should be cleaned
      const respondAfter = vi.fn();
      await healthApi.gatewayMethods['autopilot.status']({ params: { sessionKey: 'sess-orphan' }, respond: respondAfter });
      const after = respondAfter.mock.calls[0][1];
      expect(after?.projection).toBeUndefined();
    });

    it('does not clean up sessions with recent activity', async () => {
      await healthApi.gatewayMethods['autopilot.activate']({ params: { sessionKey: 'sess-active', goal: 'active task' }, respond: vi.fn() });

      // Simulate recent activity
      const llmHandler = healthApi.hooks['llm_output'];
      llmHandler(
        { usage: { input: 100, output: 50, total: 150 } },
        { sessionKey: 'sess-active' },
      );

      // Advance 1 hour — well within health check threshold
      vi.advanceTimersByTime(60 * 60 * 1000);

      // Should still exist
      const respondAfter = vi.fn();
      await healthApi.gatewayMethods['autopilot.status']({ params: { sessionKey: 'sess-active' }, respond: respondAfter });
      const after = respondAfter.mock.calls[0][1];
      expect(after?.projection).toBeDefined();
    });
  });
});
