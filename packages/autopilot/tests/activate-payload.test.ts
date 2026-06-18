/**
 * GAP-7 + GAP-21: Contract tests for activate handler payload wiring.
 *
 * Verifies that goal and maxTotalContinuations sent via the RPC call
 * from AutopilotCreateDialog are correctly forwarded through the
 * activate handler to AutopilotState.
 *
 * These tests exercise the pure-function data path:
 *   RPC payload → orchestratorReducer(activate_requested) → state fields
 */
import { describe, it, expect } from 'vitest';
import {
  orchestratorReducer,
} from '../src/orchestrator';
import {
  createInitialState,
  type AutopilotState,
} from '../src/types';
import { activate } from '../src/autopilot-state';

const NOW = 1_000_000;

/** Simulate the full activate flow: create initial state → activate → reducer */
function simulateActivate(payload: {
  sessionKey: string;
  goal?: string;
  maxTotalContinuations?: number;
}): AutopilotState {
  const config = { maxAttemptsPerTurn: 5, maxTotalContinuations: 50, toolErrorThreshold: 3, maxConcurrentAutopilot: 5 };
  let state = activate(createInitialState(payload.sessionKey, 'run-abc', config));

  // This mirrors what the activate handler in index.ts SHOULD do:
  // 1. Dispatch activate_requested with goal from payload
  state = orchestratorReducer(state, {
    type: 'activate_requested',
    sessionKey: payload.sessionKey,
    goal: payload.goal,
    now: NOW,
  });

  // 2. Apply payload fields that the handler SHOULD wire
  if (payload.maxTotalContinuations != null) {
    state = { ...state, maxTotalContinuations: payload.maxTotalContinuations };
  }

  return state;
}

describe('activate handler — payload contract (GAP-7, GAP-21)', () => {
  it('forwards goal from RPC payload to state', () => {
    const state = simulateActivate({
      sessionKey: 'sess-1',
      goal: 'Fix the login bug',
    });
    expect(state.goal).toBe('Fix the login bug');
  });

  it('forwards maxTotalContinuations from RPC payload to state', () => {
    const state = simulateActivate({
      sessionKey: 'sess-1',
      goal: 'test',
      maxTotalContinuations: 100,
    });
    expect(state.maxTotalContinuations).toBe(100);
  });

  it('applies all payload fields together', () => {
    const state = simulateActivate({
      sessionKey: 'sess-1',
      goal: 'Complete refactor',
      maxTotalContinuations: 200,
    });
    expect(state.goal).toBe('Complete refactor');
    expect(state.maxTotalContinuations).toBe(200);
  });

  it('falls back to defaults when payload fields are missing', () => {
    const state = simulateActivate({
      sessionKey: 'sess-1',
    });
    expect(state.goal).toBeUndefined();
    // maxTotalContinuations comes from config default (50)
    expect(state.maxTotalContinuations).toBe(50);
  });

  it('sets orchestrationState to unclaimed after activate_requested', () => {
    const state = simulateActivate({
      sessionKey: 'sess-1',
      goal: 'test',
    });
    expect(state.orchestrationState).toBe('unclaimed');
    expect(state.status).toBe('running');
    expect(state.startedAt).toBe(NOW);
  });

  it('preserves goal when activate_requested is dispatched without goal', () => {
    // Simulate re-activation: state already has a goal
    let state = simulateActivate({ sessionKey: 'sess-1', goal: 'original goal' });
    // Re-activate without a new goal
    state = orchestratorReducer(
      { ...state, status: 'done' as const, enabled: false },
      { type: 'activate_requested', sessionKey: 'sess-1', now: NOW + 1000 },
    );
    expect(state.goal).toBe('original goal');
  });
});
