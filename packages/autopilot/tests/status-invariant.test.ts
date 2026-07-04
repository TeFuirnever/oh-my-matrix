/**
 * W1 Phase 3: machine-checked status invariant.
 *
 * After Phase 2, status is always derived from orchState+blockedReason. This
 * test asserts the invariant holds across every setter + reducer combination
 * that production code can reach. If a future PR reintroduces a direct
 * `status:` spread that disagrees with deriveStatus, this test goes red.
 *
 * This is the "single-writer with machine-checked invariant" guard — it's the
 * practical enforcement layer (a stray spread still compiles, but CI catches it).
 */
import { describe, it, expect } from 'vitest';
import { orchestratorReducer, deriveStatus } from '../src/orchestrator';
import { activate, pause, complete, resume, deactivate } from '../src/autopilot-state';
import type { AutopilotState, OrchestratorEvent, PauseReason } from '../src/types';
import { DEFAULT_WORKFLOW_CONFIG } from '../src/workflow-config';

function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return {
    status: 'running',
    enabled: true,
    sessionKey: 'test',
    runId: 'r1',
    startedAt: 1000,
    lastActivityAt: 1000,
    totalContinuations: 0,
    turnAttempts: 0,
    maxAttemptsPerTurn: 5,
    maxTotalContinuations: 200,
    maxConcurrentAutopilot: 5,
    totalTokensUsed: 0,
    toolErrorCount: 0,
    toolErrorThreshold: 3,
    needsCrossTurnResume: false,
    degraded: false,
    orchestrationState: 'running',
    ...overrides,
  } as AutopilotState;
}

describe('W1 Phase 3 — status invariant (status === deriveStatus after every transition)', () => {
  describe('setters preserve the invariant', () => {
    it('activate: status === deriveStatus', () => {
      const state = activate(makeState({ status: 'idle', orchestrationState: undefined, enabled: false }));
      expect(state.status).toBe(deriveStatus(state));
    });

    it('pause: status === deriveStatus for every PauseReason', () => {
      const allPauses: PauseReason[] = [
        'max_attempts_reached', 'max_total_reached', 'tool_error_repeated',
        'loop_breaker_triggered', 'context_overflow_unrecoverable', 'permission_denied',
        'injection_rejected', 'user_stopped', 'token_budget_exceeded', 'validation_failed',
      ];
      for (const reason of allPauses) {
        const state = pause(makeState(), reason);
        expect(state.status).toBe(deriveStatus(state));
      }
    });

    it('complete: status === deriveStatus', () => {
      const state = complete(makeState());
      expect(state.status).toBe(deriveStatus(state));
    });

    it('resume: status === deriveStatus', () => {
      const paused = pause(makeState(), 'validation_failed');
      const state = resume(paused);
      expect(state.status).toBe(deriveStatus(state));
    });

    it('deactivate: status === deriveStatus', () => {
      const state = deactivate(makeState());
      expect(state.status).toBe(deriveStatus(state));
    });
  });

  describe('reducer events preserve the invariant', () => {
    const baseState = makeState({ orchestrationState: 'unclaimed' });
    const events: Array<{ name: string; event: OrchestratorEvent; preState?: Partial<AutopilotState> }> = [
      { name: 'activate_requested', event: { type: 'activate_requested', sessionKey: 's', now: 2000 } },
      { name: 'agent_turn_started', event: { type: 'agent_turn_started', runId: 'r1', now: 2000 }, preState: { orchestrationState: 'claimed' } },
      { name: 'agent_turn_finished (success)', event: { type: 'agent_turn_finished', runId: 'r1', success: true, now: 2000 }, preState: { orchestrationState: 'running' } },
      { name: 'agent_turn_finished (fail)', event: { type: 'agent_turn_finished', runId: 'r1', success: false, error: 'err', now: 2000 }, preState: { orchestrationState: 'running', workflow: { ...DEFAULT_WORKFLOW_CONFIG, maxRetries: 0 } } },
      { name: 'evidence_finished (passed)', event: { type: 'evidence_finished', runId: 'r1', evidence: { status: 'passed', commands: [], completedAt: 2000 }, now: 2000 }, preState: { orchestrationState: 'released' } },
      { name: 'evidence_finished (failed)', event: { type: 'evidence_finished', runId: 'r1', evidence: { status: 'failed', commands: [], completedAt: 2000 }, now: 2000 }, preState: { orchestrationState: 'released', workflow: { ...DEFAULT_WORKFLOW_CONFIG, maxRetries: 0 } } },
      { name: 'stop_requested', event: { type: 'stop_requested', runId: 'r1', now: 2000 } },
      { name: 'pause_requested', event: { type: 'pause_requested', runId: 'r1', reason: 'tool_error_repeated', now: 2000 } },
    ];

    it.each(events)('$name: status === deriveStatus', ({ event, preState }) => {
      const state = makeState({ ...baseState, ...preState });
      const result = orchestratorReducer(state, event);
      expect(result.status).toBe(deriveStatus(result));
    });
  });

  describe('status is never stale after a blocked transition', () => {
    it('a blocked run with a non-resumable reason has status=paused (not running)', () => {
      const state = pause(makeState(), 'loop_breaker_triggered');
      expect(state.status).toBe('paused');
      expect(state.orchestrationState).toBe('blocked');
      expect(state.blockedReason).toBe('loop_breaker_triggered');
    });

    it('a blocked run with user_stopped has status=idle', () => {
      const state = deactivate(makeState());
      expect(state.status).toBe('idle');
      expect(state.blockedReason).toBe('user_stopped');
    });
  });
});
