/**
 * E2E: full activate → loop → complete lifecycle.
 *
 * Drives the REGISTERED gateway methods (autopilot.activate / resume / stop /
 * status / setGoal) and the REGISTERED hooks (session_start, agent_turn_prepare,
 * before_agent_finalize, agent_end) exactly as the OpenClaw host would invoke
 * them. No direct calls into src/ reducers — every transition is produced by
 * the plugin's own wiring.
 *
 * Covers plan rows:
 *   T6  — activate creates a running run; revise loop drives turns; complete
 *         signal after MIN_TURNS_BEFORE_COMPLETE marks the run done.
 *   T10 — resume is only valid from 'paused'; rejected from every other status.
 *   T12 — MIN_TURNS_BEFORE_COMPLETE early-complete guard demotes an early
 *         "all tasks completed" signal to revise; a no-actionable-task message
 *         still completes immediately (intentional bypass).
 *   (stuck-run recovery on re-activate — isRunStuck path.)
 *
 * Every expected value is read from the real source (index.ts register(),
 * continuation-engine.ts, autopilot-state.ts, orchestrator.ts). Where the plan
 * prose disagreed with code, code wins and a `// frozen to current behavior`
 * comment marks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register, _resetForTest } from '../../index';

// ─── Mock harness (copied from plugin-entry.test.ts — the proven template) ───
function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const hookOpts = new Map<string, { priority?: number; timeoutMs?: number } | undefined>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  let sessionExtension: any = null;
  const injections: any[] = [];

  const enqueueNextTurnInjection = vi.fn(async (injection: any) => {
    injections.push(injection);
    return { enqueued: true, id: `inj-${injections.length}`, sessionKey: injection.sessionKey };
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
      pluginConfig: {} as Record<string, unknown>,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number; timeoutMs?: number }) => {
        hooks.set(hookName, handler);
        hookOpts.set(hookName, opts);
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      session,
      enqueueNextTurnInjection,
      registerSessionExtension,
    },
    hooks,
    hookOpts,
    gatewayMethods,
    getSessionExtension: () => sessionExtension,
    getInjections: () => injections,
  };
}

/** Drive N finalize turns whose message is neither complete nor no-task. */
async function driveTurns(
  finalize: (...args: unknown[]) => unknown,
  sessionId: string,
  sessionKey: string,
  n: number,
  message = 'still working on the implementation...',
) {
  for (let i = 0; i < n; i++) {
    await finalize({ sessionId, sessionKey, stopHookActive: false, lastAssistantMessage: message });
  }
}

async function activateAndStart(mock: ReturnType<typeof createMockApi>, sessionKey: string, sessionId: string, goal?: string) {
  const activate = mock.gatewayMethods.get('autopilot.activate')!;
  await activate({ params: { sessionKey, goal }, respond: vi.fn() });
  const sessionStart = mock.hooks.get('session_start')!;
  await sessionStart({ sessionId, sessionKey });
}

async function projectionFor(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const status = mock.gatewayMethods.get('autopilot.status')!;
  const respond = vi.fn();
  await status({ params: { sessionKey }, respond });
  return respond.mock.calls[0][1]?.projection;
}

describe('E2E: activate → loop → complete lifecycle', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
  });

  describe('T6 — full lifecycle via registered gateway methods + hooks', () => {
    it('activate produces a running run at orchState=claimed with zeroed counters', async () => {
      await activateAndStart(mock, 'sess-life1', 'sid-life1', 'refactor the auth module');

      const proj = await projectionFor(mock, 'sess-life1');
      expect(proj.status).toBe('running');
      expect(proj.enabled).toBe(true);
      expect(proj.totalContinuations).toBe(0);
      expect(proj.turnAttempts).toBe(0);
      // activate_requested → unclaimed, then workspace_ready → claimed.
      // frozen to current behavior: orchState is 'claimed' immediately after activate.
      expect(proj.orchestrationState).toBe('claimed');
      expect(proj.canStop).toBe(true); // running ⇒ canStop
    });

    it('each revise turn increments totalContinuations and turnAttempts', async () => {
      await activateAndStart(mock, 'sess-life2', 'sid-life2');

      const finalize = mock.hooks.get('before_agent_finalize')!;
      await driveTurns(finalize, 'sid-life2', 'sess-life2', 3);

      const proj = await projectionFor(mock, 'sess-life2');
      expect(proj.totalContinuations).toBe(3);
      // each revise increments turnAttempts too (incrementTurn then incrementTotal)
      expect(proj.turnAttempts).toBe(3);
    });

    it('completion signal after MIN_TURNS_BEFORE_COMPLETE(=2) marks run done', async () => {
      await activateAndStart(mock, 'sess-life3', 'sid-life3');

      const finalize = mock.hooks.get('before_agent_finalize')!;
      // Drive past the guard (needs totalContinuations >= 2).
      await driveTurns(finalize, 'sid-life3', 'sess-life3', 2);

      const completeResult = await finalize({
        sessionId: 'sid-life3',
        sessionKey: 'sess-life3',
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成，全部测试通过。',
      });
      // complete path returns finalize; evidence gate runs (no commands ⇒ skipped ⇒ done).
      expect(completeResult.action).toBe('finalize');

      const proj = await projectionFor(mock, 'sess-life3');
      expect(proj.status).toBe('done');
      expect(proj.enabled).toBe(false);
      // frozen to current behavior: the complete path only runs the evidence
      // reducer when orchState==='released'. Without a real agent_turn cycle the
      // run never leaves 'claimed', so complete() flips status→done but leaves
      // orchState untouched at 'claimed'.
      expect(proj.orchestrationState).toBe('claimed');
      expect(proj.canStop).toBe(true); // done ⇒ canStop true
    });

    it('can re-activate from done (counters reset on the new run)', async () => {
      await activateAndStart(mock, 'sess-life4', 'sid-life4');
      const finalize = mock.hooks.get('before_agent_finalize')!;
      await driveTurns(finalize, 'sid-life4', 'sess-life4', 2);
      await finalize({
        sessionId: 'sid-life4', sessionKey: 'sess-life4', stopHookActive: false,
        lastAssistantMessage: 'all tasks completed',
      });
      expect((await projectionFor(mock, 'sess-life4')).status).toBe('done');

      // Re-activate.
      const activate = mock.gatewayMethods.get('autopilot.activate')!;
      const respond = vi.fn();
      await activate({ params: { sessionKey: 'sess-life4' }, respond });
      expect(respond.mock.calls[0][0]).toBe(true);

      const proj = await projectionFor(mock, 'sess-life4');
      expect(proj.status).toBe('running');
      expect(proj.totalContinuations).toBe(0);
      expect(proj.turnAttempts).toBe(0);
    });
  });

  describe('T12 — MIN_TURNS_BEFORE_COMPLETE early-complete guard', () => {
    it('demotes an early "all tasks completed" to revise (does NOT complete)', async () => {
      await activateAndStart(mock, 'sess-guard1', 'sid-guard1');

      const finalize = mock.hooks.get('before_agent_finalize')!;
      // totalContinuations is 0 — well below the guard (2).
      const result = await finalize({
        sessionId: 'sid-guard1',
        sessionKey: 'sess-guard1',
        stopHookActive: false,
        lastAssistantMessage: '所有任务已完成',
      });

      // Guard fires: revise with the early-completion instruction, NOT complete.
      expect(result.action).toBe('revise');
      expect(result.retry?.instruction).toContain('early-completion guard');

      // Run is still running, not done.
      const proj = await projectionFor(mock, 'sess-guard1');
      expect(proj.status).toBe('running');
      expect(proj.totalContinuations).toBe(1); // the demoted revise still counted
    });

    it('a no-actionable-task message completes immediately, bypassing the guard', async () => {
      // frozen to current behavior: hasNoActionableTask short-circuits to complete
      // BEFORE the MIN_TURNS guard — intentional, documented in continuation-engine.ts.
      await activateAndStart(mock, 'sess-guard2', 'sid-guard2');

      const finalize = mock.hooks.get('before_agent_finalize')!;
      const result = await finalize({
        sessionId: 'sid-guard2',
        sessionKey: 'sess-guard2',
        stopHookActive: false,
        lastAssistantMessage: '你好，有什么可以帮你的吗？',
      });

      expect(result.action).toBe('finalize'); // complete path

      const proj = await projectionFor(mock, 'sess-guard2');
      expect(proj.status).toBe('done');
    });

    it('stopHookActive finalizes immediately, ignoring any completion signal', async () => {
      await activateAndStart(mock, 'sess-guard3', 'sid-guard3');
      const finalize = mock.hooks.get('before_agent_finalize')!;

      const result = await finalize({
        sessionId: 'sid-guard3',
        sessionKey: 'sess-guard3',
        stopHookActive: true, // user hit stop
        lastAssistantMessage: '所有任务已完成',
      });
      // S3 fix: decideContinuation returns {action:'finalize'} for stopHookActive
      // and the switch now has an explicit case 'finalize' → {action:'finalize'}.
      // Previously this fell through to default ('continue'), silently rewriting
      // the user's stop intent; now finalize is preserved and the host stops
      // injecting autopilot revisions for this turn.
      expect(result.action).toBe('finalize');
      // status untouched (no state transition)
      const proj = await projectionFor(mock, 'sess-guard3');
      expect(proj.status).toBe('running');
    });
  });

  describe('T10 — resume is only valid from paused', () => {
    it('rejects resume when no run exists for the session', async () => {
      const resume = mock.gatewayMethods.get('autopilot.resume')!;
      const respond = vi.fn();
      await resume({ params: { sessionKey: 'never-activated' }, respond });
      expect(respond.mock.calls[0][0]).toBe(false);
      expect(respond.mock.calls[0][2]?.message).toContain('no active run');
    });

    it('rejects resume from a running session', async () => {
      await activateAndStart(mock, 'sess-rs-running', 'sid-rs-running');
      const resume = mock.gatewayMethods.get('autopilot.resume')!;
      const respond = vi.fn();
      await resume({ params: { sessionKey: 'sess-rs-running' }, respond });
      expect(respond.mock.calls[0][0]).toBe(false);
      // frozen to current behavior: error message names the current status.
      expect(respond.mock.calls[0][2]?.message).toContain('cannot resume from status "running"');
    });

    it('rejects resume from a done session', async () => {
      await activateAndStart(mock, 'sess-rs-done', 'sid-rs-done');
      const finalize = mock.hooks.get('before_agent_finalize')!;
      await driveTurns(finalize, 'sid-rs-done', 'sess-rs-done', 2);
      await finalize({
        sessionId: 'sid-rs-done', sessionKey: 'sess-rs-done', stopHookActive: false,
        lastAssistantMessage: 'all tasks completed',
      });
      expect((await projectionFor(mock, 'sess-rs-done')).status).toBe('done');

      const resume = mock.gatewayMethods.get('autopilot.resume')!;
      const respond = vi.fn();
      await resume({ params: { sessionKey: 'sess-rs-done' }, respond });
      expect(respond.mock.calls[0][0]).toBe(false);
      expect(respond.mock.calls[0][2]?.message).toContain('cannot resume from status "done"');
    });

    it('resumes a paused session back to running and clears the pause reason', async () => {
      await activateAndStart(mock, 'sess-rs-pause', 'sid-rs-pause');
      // Pause via the max_total_reached path: drive totalContinuations to max (default 50).
      const finalize = mock.hooks.get('before_agent_finalize')!;
      await driveTurns(finalize, 'sid-rs-pause', 'sess-rs-pause', 50);
      // One more finalize at max totalContinuations ⇒ pause with max_total_reached.
      await finalize({
        sessionId: 'sid-rs-pause', sessionKey: 'sess-rs-pause', stopHookActive: false,
        lastAssistantMessage: 'still working...',
      });

      const projPaused = await projectionFor(mock, 'sess-rs-pause');
      expect(projPaused.status).toBe('paused');
      expect(projPaused.pauseReason).toBe('max_total_reached');

      const resume = mock.gatewayMethods.get('autopilot.resume')!;
      const respond = vi.fn();
      await resume({ params: { sessionKey: 'sess-rs-pause' }, respond });
      expect(respond.mock.calls[0][0]).toBe(true);

      const projResumed = await projectionFor(mock, 'sess-rs-pause');
      expect(projResumed.status).toBe('running');
      expect(projResumed.enabled).toBe(true);
      expect(projResumed.pauseReason).toBeUndefined();
    });
  });

  describe('stuck-run recovery on re-activate (isRunStuck)', () => {
    it('re-activates a stuck running session (no activity beyond stall threshold)', async () => {
      // frozen to current behavior: a running session whose lastActivityAt is older
      // than the stall threshold is treated as stuck and discarded on re-activate,
      // instead of the normal "cannot activate from running" rejection.
      //
      // Fake timers must be active BEFORE register()+activate so Date.now() during
      // activate_requested/workspace_ready returns the fake clock (t=0); only then
      // does advancing the clock push (now - lastActivityAt) past the threshold.
      vi.useFakeTimers();
      try {
        _resetForTest();
        const stuckMock = createMockApi();
        register(stuckMock.api as any);

        await activateAndStart(stuckMock, 'sess-stuck', 'sid-stuck');

        // Move orchState claimed → running via the agent_turn_prepare hook
        // (it dispatches agent_turn_started, claimed→running).
        const turnPrepare = stuckMock.hooks.get('agent_turn_prepare')!;
        turnPrepare({ prompt: 'go' }, { sessionKey: 'sess-stuck' });

        // Advance past the default stall timeout (600_000ms, no tokenBudget)
        // plus one stall-check interval (60_000ms) so the interval fires.
        // stall-detector uses strict '>' so we go one tick over.
        vi.advanceTimersByTime(600_000 + 60_000 + 1);

        const projStuck = await projectionFor(stuckMock, 'sess-stuck');
        // frozen to current behavior: stall sets orchState='retry_queued', status stays 'running'.
        expect(projStuck.status).toBe('running');
        expect(projStuck.orchestrationState).toBe('retry_queued');

        // Re-activate the stuck session — must succeed (recovery path), not reject.
        const activate = stuckMock.gatewayMethods.get('autopilot.activate')!;
        const respond = vi.fn();
        await activate({ params: { sessionKey: 'sess-stuck' }, respond });
        expect(respond.mock.calls[0][0]).toBe(true);

        const projNew = await projectionFor(stuckMock, 'sess-stuck');
        expect(projNew.status).toBe('running');
        // New run: counters reset, orchState back at claimed (fresh activate).
        expect(projNew.totalContinuations).toBe(0);
        expect(projNew.orchestrationState).toBe('claimed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects re-activate of a genuinely-active running session (not stuck)', async () => {
      await activateAndStart(mock, 'sess-active', 'sid-active');
      // No stall, no retry_queued, fresh lastActivityAt ⇒ isRunStuck false.
      const activate = mock.gatewayMethods.get('autopilot.activate')!;
      const respond = vi.fn();
      await activate({ params: { sessionKey: 'sess-active' }, respond });
      expect(respond.mock.calls[0][0]).toBe(false);
      expect(respond.mock.calls[0][2]?.message).toContain('cannot activate from status "running"');
    });
  });

  describe('stop transitions through the registered gateway method', () => {
    it('stop from running → idle and clears enabled', async () => {
      await activateAndStart(mock, 'sess-stop1', 'sid-stop1');
      const stop = mock.gatewayMethods.get('autopilot.stop')!;
      const respond = vi.fn();
      await stop({ params: { sessionKey: 'sess-stop1' }, respond });
      expect(respond.mock.calls[0][0]).toBe(true);

      const proj = await projectionFor(mock, 'sess-stop1');
      expect(proj.status).toBe('idle');
      expect(proj.enabled).toBe(false);
    });

    it('stop on an unknown session responds ok (idempotent)', async () => {
      const stop = mock.gatewayMethods.get('autopilot.stop')!;
      const respond = vi.fn();
      await stop({ params: { sessionKey: 'never-seen' }, respond });
      expect(respond.mock.calls[0][0]).toBe(true);
    });
  });
});
