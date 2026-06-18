/**
 * Coverage gap: goal-manager.ts (66.7% → target 90%)
 * Tests all three exported functions: captureGoal, preserveGoalBeforeCompaction, restoreGoalAfterCompaction
 */
import { describe, it, expect } from 'vitest';
import { captureGoal, preserveGoalBeforeCompaction, restoreGoalAfterCompaction } from '../src/goal-manager';
import type { AutopilotState } from '../src/types';
import { setGoal as setGoalFn, snapshotGoal } from '../src/autopilot-state';

function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return {
    status: 'idle',
    sessionKey: 'test-session',
    runId: 'run-test',
    turnAttempts: 0,
    totalContinuations: 0,
    maxAttemptsPerTurn: 5,
    maxTotalContinuations: 50,
    maxConcurrentAutopilot: 5,
    toolErrorCount: 0,
    toolErrorThreshold: 3,
    needsCrossTurnResume: false,
    enabled: false,
    totalTokensUsed: 0,
    ...overrides,
  };
}

describe('goal-manager', () => {
  describe('captureGoal', () => {
    it('captures non-empty user message as goal when enabled', () => {
      const state = makeState({ enabled: true });
      const result = captureGoal(state, 'Fix all TypeScript errors');
      expect(result.goal).toBe('Fix all TypeScript errors');
    });

    it('trims whitespace from user message', () => {
      const state = makeState({ enabled: true });
      const result = captureGoal(state, '  Refactor auth module  ');
      expect(result.goal).toBe('Refactor auth module');
    });

    it('returns state unchanged when disabled', () => {
      const state = makeState({ enabled: false });
      const result = captureGoal(state, 'Fix all TypeScript errors');
      expect(result.goal).toBe(state.goal);
    });

    it('returns state unchanged when message is empty', () => {
      const state = makeState({ enabled: true });
      const result = captureGoal(state, '');
      expect(result.goal).toBe(state.goal);
    });

    it('returns state unchanged when message is whitespace only', () => {
      const state = makeState({ enabled: true });
      const result = captureGoal(state, '   ');
      expect(result.goal).toBe(state.goal);
    });

    it('captures goal when no existing goal is set', () => {
      const state = makeState({ enabled: true });
      // setGoal only sets if no goal exists, so captureGoal is used for first goal
      const result = captureGoal(state, 'New goal');
      expect(result.goal).toBe('New goal');
    });
  });

  describe('preserveGoalBeforeCompaction', () => {
    it('snapshots goal when enabled and goal exists', () => {
      let state = makeState({ enabled: true });
      state = setGoalFn(state, 'My task goal');
      const result = preserveGoalBeforeCompaction(state);
      expect(result.goalSnapshot).toBe('My task goal');
    });

    it('returns state unchanged when disabled', () => {
      let state = makeState({ enabled: false });
      state = setGoalFn(state, 'My task goal');
      const result = preserveGoalBeforeCompaction(state);
      expect(result.goalSnapshot).toBe(state.goalSnapshot);
    });

    it('returns state unchanged when goal is empty', () => {
      const state = makeState({ enabled: true });
      const result = preserveGoalBeforeCompaction(state);
      expect(result.goalSnapshot).toBe(state.goalSnapshot);
    });
  });

  describe('restoreGoalAfterCompaction', () => {
    it('restores goal from snapshot when enabled', () => {
      let state = makeState({ enabled: true });
      state = setGoalFn(state, 'Original goal');
      state = snapshotGoal(state); // saves to goalSnapshot
      state = { ...state, goal: undefined }; // simulate compaction clearing goal
      const result = restoreGoalAfterCompaction(state);
      expect(result.goal).toBe('Original goal');
    });

    it('returns state unchanged when disabled', () => {
      const state = makeState({ enabled: false });
      const result = restoreGoalAfterCompaction(state);
      expect(result).toEqual(state);
    });

    it('returns state unchanged when no snapshot exists', () => {
      const state = makeState({ enabled: true });
      const result = restoreGoalAfterCompaction(state);
      expect(result).toEqual(state);
    });
  });
});
