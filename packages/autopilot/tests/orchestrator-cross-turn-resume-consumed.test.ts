/**
 * ADR-020 Step 2: cross_turn_resume_consumed event.
 *
 * The needsCrossTurnResume flag is set true by cross-turn transitions (resume,
 * cross_turn_degraded) to signal the host driver "resume me". It must be
 * cleared when the resumed turn actually begins finalizing — at
 * before_agent_finalize — or sessions.changed keeps broadcasting the flag and
 * the host re-sends chat.send forever (the infinite-loop fix at index.ts:530).
 *
 * That clear was a bare spread. Step 2 folds it into a reducer event so the
 * reducer stays the sole writer of needsCrossTurnResume.
 *
 * NOTE: the lifecycle is before_agent_finalize (host handshake), NOT
 * agent_turn_started (which fires later at turn dispatch). An earlier draft of
 * the design matrix had the wrong lifecycle; this test pins the real one.
 */
import { describe, it, expect } from 'vitest';
import { orchestratorReducer } from '../src/orchestrator';
import { type AutopilotState, createInitialState } from '../src/types';

function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return { ...createInitialState('sess-1', 'run-1'), ...overrides };
}

const ev = (now: number) => ({ type: 'cross_turn_resume_consumed' as const, runId: 'run-1', now });

describe('cross_turn_resume_consumed event (ADR-020 step 2)', () => {
  it('clears needsCrossTurnResume when it was true', () => {
    const before = makeState({
      status: 'running',
      orchestrationState: 'running',
      needsCrossTurnResume: true,
    });
    const after = orchestratorReducer(before, ev(1000));
    expect(after.needsCrossTurnResume).toBe(false);
  });

  it('stamps lastActivityAt (the consumption is real activity)', () => {
    const before = makeState({
      status: 'running',
      orchestrationState: 'running',
      needsCrossTurnResume: true,
      lastActivityAt: 500,
    });
    const after = orchestratorReducer(before, ev(1000));
    expect(after.lastActivityAt).toBe(1000);
  });

  it('is a no-op when needsCrossTurnResume is already false (idempotent handshake)', () => {
    const before = makeState({
      status: 'running',
      orchestrationState: 'running',
      needsCrossTurnResume: false,
    });
    const after = orchestratorReducer(before, ev(1000));
    // Only lastActivityAt moves; the flag was already clear. Acceptable: the
    // event firing at all means a turn is finalizing, which is activity.
    expect(after.needsCrossTurnResume).toBe(false);
  });

  it('does not touch other coupled aux fields (only the handshake flag)', () => {
    const before = makeState({
      status: 'running',
      orchestrationState: 'running',
      needsCrossTurnResume: true,
      degraded: true,
      toolErrorCount: 3,
      pauseReason: undefined,
    });
    const after = orchestratorReducer(before, ev(1000));
    expect(after.degraded).toBe(true);
    expect(after.toolErrorCount).toBe(3);
  });
});
