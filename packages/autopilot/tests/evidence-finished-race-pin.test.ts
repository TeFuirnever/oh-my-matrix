/**
 * ADR-020 Step 3 pin: evidence_finished does NOT force done when orchState !=
 * 'released'. The reducer has always no-op'd here; this test pins it so the
 * H1 backdoor (complete() forcing done on a race) cannot regress via a
 * relaxed guard.
 *
 * The race: a stop/stall/retry interleaves while evidence is in flight, moving
 * orchState off 'released'. Evidence then arrives "passed" but the run is no
 * longer in the evidence-gate state. The correct behavior is to PRESERVE
 * orchState (warn at the caller), not complete. Surfacing the race beats
 * masking it as a finish.
 */
import { describe, it, expect } from 'vitest';
import { orchestratorReducer } from '../src/orchestrator';
import { type AutopilotState, type EvidenceSummary, createInitialState } from '../src/types';

function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return { ...createInitialState('sess-1', 'run-1'), ...overrides };
}
const passedEvidence: EvidenceSummary = { status: 'passed', commands: [], failureReason: undefined };

describe('evidence_finished race pin (ADR-020 step 3)', () => {
  it('passed evidence when orchState is blocked (stop raced) → stays blocked, NOT done', () => {
    const before = makeState({
      status: 'paused',
      orchestrationState: 'blocked',
      blockedReason: 'validation_failed',
    });
    const after = orchestratorReducer(before, {
      type: 'evidence_finished',
      runId: 'run-1',
      evidence: passedEvidence,
      now: 1000,
    });
    // Reducer no-ops on orchState !== 'released'; the race is surfaced, not
    // masked as a finish. Pin: orchState preserved, status never becomes 'done'.
    expect(after.orchestrationState).toBe('blocked');
    expect(after.status).not.toBe('done');
  });

  it('passed evidence when orchState is retry_queued (stall raced) → stays retry_queued', () => {
    const before = makeState({
      status: 'running',
      orchestrationState: 'retry_queued',
    });
    const after = orchestratorReducer(before, {
      type: 'evidence_finished',
      runId: 'run-1',
      evidence: passedEvidence,
      now: 1000,
    });
    expect(after.orchestrationState).toBe('retry_queued');
    expect(after.status).not.toBe('done');
  });

  it('passed evidence when orchState IS released → done (the legit path, unchanged)', () => {
    const before = makeState({
      status: 'running',
      orchestrationState: 'released',
    });
    const after = orchestratorReducer(before, {
      type: 'evidence_finished',
      runId: 'run-1',
      evidence: passedEvidence,
      now: 1000,
    });
    expect(after.orchestrationState).toBe('done');
    expect(after.status).toBe('done');
  });
});
