/**
 * ADR-020 Step 1 (TDD): cross_turn_degraded event.
 *
 * Today the degraded cross-turn fallback is a bare spread at index.ts:1058:
 *   setState(runId, { ...current, totalContinuations+1, needsCrossTurnResume:true,
 *                     turnAttempts:0, degraded:true });
 * ADR-020 folds this into a reducer event so the reducer is the sole writer of
 * those coupled aux fields. This test drives the reducer directly.
 *
 * Contract (design doc §8.2.1 + ADR-020):
 *  - guard: warn + no-op when status !== 'running' (cross-turn only from an
 *    active state; released/claimed/etc all derive to 'running').
 *  - on apply: totalContinuations++, needsCrossTurnResume=true, turnAttempts=0,
 *    degraded=true, lastActivityAt=now, status re-derived.
 */
import { describe, it, expect } from 'vitest';
import { orchestratorReducer } from '../src/orchestrator';
import { type AutopilotState, createInitialState } from '../src/types';

function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return { ...createInitialState('sess-1', 'run-1'), ...overrides };
}

const ev = (now: number) => ({ type: 'cross_turn_degraded' as const, runId: 'run-1', now });

describe('cross_turn_degraded event (ADR-020 step 1)', () => {
  it('increments totalContinuations, sets needsCrossTurnResume + degraded, resets turnAttempts', () => {
    const before = makeState({
      status: 'running',
      orchestrationState: 'released',
      totalContinuations: 5,
      turnAttempts: 3,
      needsCrossTurnResume: false,
      degraded: false,
    });
    const after = orchestratorReducer(before, ev(1000));
    expect(after.totalContinuations).toBe(6);
    expect(after.needsCrossTurnResume).toBe(true);
    expect(after.degraded).toBe(true);
    expect(after.turnAttempts).toBe(0);
    expect(after.lastActivityAt).toBe(1000);
  });

  it('preserves status as running (derived from an active orchState)', () => {
    const before = makeState({ status: 'running', orchestrationState: 'released' });
    const after = orchestratorReducer(before, ev(1000));
    expect(after.status).toBe('running');
  });

  it('no-ops when status is not running (e.g. done)', () => {
    // Self-consistent non-running state: done derives from orchState='done'.
    const before = makeState({
      status: 'done',
      orchestrationState: 'done',
      totalContinuations: 5,
    });
    const after = orchestratorReducer(before, ev(1000));
    // Unchanged — cross-turn can't start from a non-active state.
    expect(after).toEqual(before);
  });

  it('does not reset toolErrorCount or pauseReason (those belong to resume/pause transitions)', () => {
    const before = makeState({
      status: 'running',
      orchestrationState: 'released',
      toolErrorCount: 2,
      pauseReason: undefined,
    });
    const after = orchestratorReducer(before, ev(1000));
    expect(after.toolErrorCount).toBe(2);
  });
});
