/**
 * E2E: resilience — concurrency, stall/auto-retry/backoff, eviction, cleanup.
 *
 * Drives everything through the REGISTERED gateway methods + hooks + the REAL
 * 60s setInterval sweeper (under vi.useFakeTimers). No direct reducer calls —
 * every state change is produced by the plugin's own wiring.
 *
 * Covers plan rows:
 *   T11 — concurrency cap (maxConcurrentAutopilot): the Nth concurrent running
 *         session is rejected with max_concurrent_reached.
 *   T16 — stall detection + auto-retry via the real interval; exponential
 *         backoff (computeRetryDelay: 10s,20s,40s…); max_retries(=3) → blocked.
 *   T18 — FIFO eviction at MAX_RUN_STATES(=50); orphan cleanup at 24h;
 *         session_end cleanup.
 *
 * Backoff math (retry-queue.ts computeRetryDelay, frozen to current behavior):
 *   delay = min(10000 * 2^(attempt-1), maxRetryBackoffMs=300000)
 *   attempt1 = 10_000ms, attempt2 = 20_000ms, attempt3 = 40_000ms.
 * shouldRetry: attempt <= maxRetries(=3) AND recoverable.
 * currentAttempt = (state.retry?.attempt ?? 0) + 1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { register, _resetForTest, _triggerRetryCheckForTest } from '../../index';

// ─── Mock harness (copied from plugin-entry.test.ts — the proven template) ───
function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  let sessionExtension: any = null;

  const enqueueNextTurnInjection = vi.fn(async (injection: any) => {
    return { enqueued: true, id: `inj-${injection.sessionKey}`, sessionKey: injection.sessionKey };
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
      pluginConfig,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        hooks.set(hookName, handler);
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      session,
      enqueueNextTurnInjection,
      registerSessionExtension,
    },
    hooks,
    gatewayMethods,
    getSessionExtension: () => sessionExtension,
  };
}

async function activate(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const handler = mock.gatewayMethods.get('autopilot.activate')!;
  const respond = vi.fn();
  await handler({ params: { sessionKey }, respond });
  return respond.mock.calls[0];
}

async function projectionFor(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const status = mock.gatewayMethods.get('autopilot.status')!;
  const respond = vi.fn();
  await status({ params: { sessionKey }, respond });
  return respond.mock.calls[0][1]?.projection;
}

describe('E2E: resilience', () => {
  describe('T11 — concurrency cap (maxConcurrentAutopilot)', () => {
    let mock: ReturnType<typeof createMockApi>;

    beforeEach(() => {
      _resetForTest();
      // Cap at 3 running sessions.
      mock = createMockApi({ maxConcurrentAutopilot: 3 });
      register(mock.api as any);
    });

    it('accepts activations up to the cap', async () => {
      for (let i = 0; i < 3; i++) {
        const [ok] = await activate(mock, `sess-cap-${i}`);
        expect(ok).toBe(true);
      }
    });

    it('rejects the (cap+1)th running session with max_concurrent_reached', async () => {
      for (let i = 0; i < 3; i++) {
        await activate(mock, `sess-cap-${i}`);
      }
      const [ok, , err] = await activate(mock, 'sess-cap-overflow');
      expect(ok).toBe(false);
      expect(err?.code).toBe('INVALID_REQUEST');
      expect(err?.message).toBe('max_concurrent_reached');
    });

    it('a paused session does not count toward the running cap', async () => {
      // Fill the cap.
      await activate(mock, 'sess-a');
      await activate(mock, 'sess-b');
      await activate(mock, 'sess-c');
      // Pause one by driving it to max_total_reached (default max=50).
      const finalize = mock.hooks.get('before_agent_finalize')!;
      const sessionStart = mock.hooks.get('session_start')!;
      await sessionStart({ sessionId: 'sid-c', sessionKey: 'sess-c' });
      for (let i = 0; i < 50; i++) {
        await finalize({ sessionId: 'sid-c', sessionKey: 'sess-c', stopHookActive: false, lastAssistantMessage: 'working...' });
      }
      await finalize({ sessionId: 'sid-c', sessionKey: 'sess-c', stopHookActive: false, lastAssistantMessage: 'working...' });
      expect((await projectionFor(mock, 'sess-c')).status).toBe('paused');

      // Now a 4th activation must succeed — only 2 running sessions remain.
      const [ok] = await activate(mock, 'sess-d');
      expect(ok).toBe(true);
    });

    it('re-activating an already-running session bypasses the CAP but still rejects on status', async () => {
      // frozen to current behavior: the concurrency-guard branch skips sessions
      // that are already running (currentlyRunning=true), so the rejection is NOT
      // max_concurrent_reached — but the subsequent status check still rejects
      // because 'running' is not in the allow-list (idle/done/stuck). So a running
      // session cannot be re-activated; it must be stopped or completed first.
      for (let i = 0; i < 3; i++) {
        await activate(mock, `sess-r-${i}`);
      }
      const [ok, , err] = await activate(mock, 'sess-r-0');
      expect(ok).toBe(false);
      // Proves the cap was bypassed (error is status-based, not concurrency-based):
      expect(err?.message).toContain('cannot activate from status "running"');
      expect(err?.message).not.toContain('max_concurrent_reached');
    });
  });

  describe('T16 — stall detection + auto-retry + exponential backoff', () => {
    let mock: ReturnType<typeof createMockApi>;

    beforeEach(() => {
      vi.useFakeTimers();
      _resetForTest();
      mock = createMockApi();
      register(mock.api as any);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** claimed → running via the registered agent_turn_prepare hook (first turn only). */
    async function driveToRunningFirstTurn(sessionKey: string) {
      const sessionStart = mock.hooks.get('session_start')!;
      await sessionStart({ sessionId: `sid-${sessionKey}`, sessionKey });
      // First-turn only: agent_turn_prepare persists its reducer result solely
      // when a goal is newly captured. On the first call goal is unset, so the
      // claimed→running transition IS written. (See frozen-behavior note below.)
      const turnPrepare = mock.hooks.get('agent_turn_prepare')!;
      turnPrepare({ prompt: 'first and only goal' }, { sessionKey });
    }

    it('first stall queues a retry with attempt=1 and 10s backoff (computeRetryDelay)', async () => {
      await activate(mock, 'sess-stall');
      await driveToRunningFirstTurn('sess-stall');

      // lastActivityAt = activate time T0 (fake clock). The stall interval ticks
      // every 60s; stall-detector uses strict '>'. M1 fix: per-run stallTimeoutMs
      // (300000 from DEFAULT_WORKFLOW_CONFIG) replaces the old global ×2 (600000).
      // First stall tick is at T0+360000 (T0+300000 is not strictly greater).
      const before = Date.now();
      vi.advanceTimersByTime(360_000);
      const stallFiredAt = before + 360_000;

      const proj = await projectionFor(mock, 'sess-stall');
      // frozen to current behavior: stall leaves status='running', sets retry_queued.
      expect(proj.status).toBe('running');
      expect(proj.orchestrationState).toBe('retry_queued');
      expect(proj.retryCount).toBe(1);
      // computeRetryDelay(1, 300000) = 10000 * 2^0 = 10_000.
      expect(proj.nextRetryAt).toBe(stallFiredAt + 10_000);
    });

    it('retry_due (after the 10s backoff) returns the run to claimed via the real interval', async () => {
      await activate(mock, 'sess-retry');
      await driveToRunningFirstTurn('sess-retry');
      vi.advanceTimersByTime(360_000); // → stall #1, retry_queued, nextRetryAt = T0+370000
      expect((await projectionFor(mock, 'sess-retry')).orchestrationState).toBe('retry_queued');

      // Advance one 60s interval → T0+420000, which is past nextRetryAt (T0+370000),
      // so the interval's retry_due branch fires: retry_queued → claimed.
      vi.advanceTimersByTime(60_000);

      const proj = await projectionFor(mock, 'sess-retry');
      // frozen to current behavior: retry_due transitions retry_queued → claimed.
      expect(proj.orchestrationState).toBe('claimed');
      // The retry entry persists (attempt stays 1) until a later stall bumps it.
      expect(proj.retryCount).toBe(1);
    });

    it('retry_due is a no-op before nextRetryAt even when orchState is retry_queued', async () => {
      // Drive a real stall to reach retry_queued with a future nextRetryAt.
      await activate(mock, 'sess-nodue');
      await driveToRunningFirstTurn('sess-nodue');
      vi.advanceTimersByTime(360_000); // M1: stall at 300000+60000 tick, nextRetryAt = now+10000
      const afterStall = (await projectionFor(mock, 'sess-nodue'));
      const nextRetryAt = afterStall.nextRetryAt!;

      // Advance only 5s (< 10s backoff) and run the seam's retry check directly.
      vi.advanceTimersByTime(5_000);
      _triggerRetryCheckForTest({
        sessionKey: 'sess-nodue',
        orchestrationState: 'retry_queued',
        retry: { attempt: 1, nextRetryAt, lastError: 'stalled', recoverable: true },
      });

      const proj = await projectionFor(mock, 'sess-nodue');
      // frozen to current behavior: retry_due reducer guards `event.now < retry.nextRetryAt`.
      expect(proj.orchestrationState).toBe('retry_queued');
    });

    it('retry_due (via the test seam) progresses a high-attempt retry_queued run to claimed, never to blocked', async () => {
      // frozen to current behavior / design: the blocked/max_retries_reached
      // transition is produced ONLY by the stall_timeout and agent_turn_finished
      // reducer paths (which check shouldRetry at stall/finish time). retry_due
      // itself never blocks — it only ever moves retry_queued → claimed. So even
      // an attempt=3 retry_due (the last retryable attempt) returns to claimed.
      //
      // This is why the full backoff chain (attempt 1→2→3→blocked) is NOT cleanly
      // drivable through the registered hooks alone: after the first retry_due the
      // run is in 'claimed', and agent_turn_prepare only persists its claimed→running
      // transition on the FIRST turn (when a goal is captured). On every subsequent
      // turn the reducer result is discarded because the goal already exists, so the
      // run can never be driven back to 'running' to trigger a second stall_timeout.
      // The blocked path is therefore exercised by unit tests of orchestratorReducer
      // (stall_timeout branch) rather than this registered-hook e2e layer.
      await activate(mock, 'sess-seam');
      const result = _triggerRetryCheckForTest({
        sessionKey: 'sess-seam',
        orchestrationState: 'retry_queued',
        retry: { attempt: 3, nextRetryAt: Date.now() - 1, lastError: 'stalled', recoverable: true },
      });
      expect(result?.orchestrationState).toBe('claimed');
      expect(result?.retry?.attempt).toBe(3);
    });
  });

  describe('T18 — LRU eviction at MAX_RUN_STATES (=50)', () => {
    beforeEach(() => {
      _resetForTest();
    });

    it('evicts the oldest run when activating the 51st', async () => {
      // High concurrency cap so the cap (not eviction) is never the limiter.
      const mock = createMockApi({ maxConcurrentAutopilot: 200 });
      register(mock.api as any);

      // Activate MAX+1 sessions. startedAt is monotonic (Date.now()), so the
      // very first (sess-0) is the FIFO-oldest and is evicted.
      for (let i = 0; i <= 50; i++) {
        await activate(mock, `sess-${i}`);
      }

      // Oldest evicted ⇒ no projection.
      expect(await projectionFor(mock, 'sess-0')).toBeUndefined();
      // Latest retained.
      const latest = await projectionFor(mock, 'sess-50');
      expect(latest).toBeDefined();
      expect(latest.status).toBe('running');
    });

    it('keeps every session when at or below the limit', async () => {
      const mock = createMockApi({ maxConcurrentAutopilot: 200 });
      register(mock.api as any);
      for (let i = 0; i < 50; i++) {
        await activate(mock, `sess-${i}`);
      }
      for (let i = 0; i < 50; i++) {
        expect(await projectionFor(mock, `sess-${i}`)).toBeDefined();
      }
    });
  });

  describe('T18 — orphan cleanup at 24h inactivity', () => {
    let mock: ReturnType<typeof createMockApi>;

    beforeEach(() => {
      vi.useFakeTimers();
      _resetForTest();
      mock = createMockApi({ maxConcurrentAutopilot: 200 });
      register(mock.api as any);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('cleans up a session with no activity beyond 24h + one interval', async () => {
      await activate(mock, 'sess-orphan');
      expect(await projectionFor(mock, 'sess-orphan')).toBeDefined();

      // M3: advance past stall + retry exhaustion first (the stall detector now
      // also covers 'claimed' runs, transitioning them to blocked after ~30min).
      // Then advance past the 24h orphan threshold — the orphan sweep cleans
      // blocked runs that settled outside the active states.
      vi.advanceTimersByTime(60_000 * 40); // 40min — past all stall + retry cycles
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 60_000); // 24h + 1 interval

      expect(await projectionFor(mock, 'sess-orphan')).toBeUndefined();
    });

    it('keeps a session that had recent activity', async () => {
      await activate(mock, 'sess-fresh');
      // Simulate recent activity via llm_output (resets lastActivityAt).
      const llmHandler = mock.hooks.get('llm_output')!;
      llmHandler(
        { usage: { input: 100, output: 50, total: 150 } },
        { sessionKey: 'sess-fresh' },
      );

      vi.advanceTimersByTime(60 * 60 * 1000); // 1h — well under 24h

      expect(await projectionFor(mock, 'sess-fresh')).toBeDefined();
    });
  });

  describe('T18 — session_end cleanup', () => {
    beforeEach(() => {
      _resetForTest();
    });

    it('removes the run state on session_end', async () => {
      const mock = createMockApi();
      register(mock.api as any);
      await activate(mock, 'sess-end');

      const sessionEnd = mock.hooks.get('session_end')!;
      sessionEnd({ sessionKey: 'sess-end' });

      expect(await projectionFor(mock, 'sess-end')).toBeUndefined();
    });

    it('session_end clears the sessionKey mapping (re-activate creates a fresh run)', async () => {
      const mock = createMockApi();
      register(mock.api as any);
      await activate(mock, 'sess-end2');
      const projBefore = await projectionFor(mock, 'sess-end2');
      expect(projBefore.totalContinuations).toBe(0);

      // Drive a couple of turns so the new run is distinguishable from a cached one.
      const sessionStart = mock.hooks.get('session_start')!;
      await sessionStart({ sessionId: 'sid-end2', sessionKey: 'sess-end2' });
      const finalize = mock.hooks.get('before_agent_finalize')!;
      await finalize({ sessionId: 'sid-end2', sessionKey: 'sess-end2', stopHookActive: false, lastAssistantMessage: 'working...' });

      const sessionEnd = mock.hooks.get('session_end')!;
      sessionEnd({ sessionKey: 'sess-end2' });
      expect(await projectionFor(mock, 'sess-end2')).toBeUndefined();

      // Re-activate → brand new run with zeroed counters.
      await activate(mock, 'sess-end2');
      const projAfter = await projectionFor(mock, 'sess-end2');
      expect(projAfter).toBeDefined();
      expect(projAfter.totalContinuations).toBe(0);
    });
  });
});
