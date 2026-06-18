import { describe, it, expect } from 'vitest';
import {
  createInitialState,
} from '../src/types';
import {
  activate,
  deactivate,
  pause,
  complete,
  resume,
  incrementTurn,
  incrementTotal,
  resetTurnAttempts,
  setGoal,
  snapshotGoal,
  restoreGoalFromSnapshot,
} from '../src/autopilot-state';

describe('autopilot-state', () => {
  const base = () => createInitialState('session-1', 'run-1');

  describe('state transitions', () => {
    it('activate: idle → running', () => {
      const state = base();
      const next = activate(state);
      expect(next.status).toBe('running');
      expect(next.enabled).toBe(true);
    });

    it('activate: throws if not idle', () => {
      const state = { ...base(), status: 'running' as const };
      expect(() => activate(state)).toThrow();
    });

    it('deactivate: running → idle', () => {
      const state = { ...base(), status: 'running' as const, enabled: true };
      const next = deactivate(state);
      expect(next.status).toBe('idle');
      expect(next.enabled).toBe(false);
    });

    it('deactivate: paused → idle', () => {
      const state = { ...base(), status: 'paused' as const, enabled: true };
      const next = deactivate(state);
      expect(next.status).toBe('idle');
    });

    it('pause: running → paused with reason', () => {
      const state = { ...base(), status: 'running' as const, enabled: true };
      const next = pause(state, 'tool_error_repeated');
      expect(next.status).toBe('paused');
      expect(next.pauseReason).toBe('tool_error_repeated');
    });

    it('pause: clears needsCrossTurnResume', () => {
      const state = { ...base(), status: 'running' as const, enabled: true, needsCrossTurnResume: true };
      const next = pause(state, 'tool_error_repeated');
      expect(next.needsCrossTurnResume).toBe(false);
    });

    it('complete: running → done', () => {
      const state = { ...base(), status: 'running' as const, enabled: true };
      const next = complete(state);
      expect(next.status).toBe('done');
      expect(next.enabled).toBe(false);
    });

    it('resume: paused → running', () => {
      const state = { ...base(), status: 'paused' as const, enabled: true, pauseReason: 'tool_error_repeated' as const };
      const next = resume(state);
      expect(next.status).toBe('running');
      expect(next.pauseReason).toBeUndefined();
    });

    it('resume: resets degraded flag', () => {
      const state = { ...base(), status: 'paused' as const, enabled: false, degraded: true };
      const next = resume(state);
      expect(next.degraded).toBe(false);
    });

    it('resume() preserves totalTokensUsed when resuming paused session', () => {
      const state = { ...base(), status: 'paused' as const, enabled: false, totalTokensUsed: 1500, pauseReason: 'token_budget_exceeded' as const };
      const next = resume(state);
      expect(next.totalTokensUsed).toBe(1500);
    });

    it('resume: throws if not paused', () => {
      const state = { ...base(), status: 'idle' as const };
      expect(() => resume(state)).toThrow();
    });

    // C1: pause() must validate status — only running → paused is valid
    it('pause: throws if not running', () => {
      const state = { ...base(), status: 'idle' as const };
      expect(() => pause(state, 'tool_error_repeated')).toThrow(/cannot pause from status "idle"/i);
    });

    it('pause: throws if already paused', () => {
      const state = { ...base(), status: 'paused' as const, pauseReason: 'tool_error_repeated' as const };
      expect(() => pause(state, 'max_total_reached')).toThrow(/cannot pause from status "paused"/i);
    });

    it('pause: throws if done', () => {
      const state = { ...base(), status: 'done' as const };
      expect(() => pause(state, 'user_stopped')).toThrow(/cannot pause from status "done"/i);
    });

    // C1: complete() must validate status — only running → done is valid
    it('complete: throws if not running', () => {
      const state = { ...base(), status: 'idle' as const };
      expect(() => complete(state)).toThrow(/cannot complete from status "idle"/i);
    });

    it('complete: throws if already done', () => {
      const state = { ...base(), status: 'done' as const };
      expect(() => complete(state)).toThrow(/cannot complete from status "done"/i);
    });

    it('complete: throws if paused', () => {
      const state = { ...base(), status: 'paused' as const, pauseReason: 'tool_error_repeated' as const };
      expect(() => complete(state)).toThrow(/cannot complete from status "paused"/i);
    });

    it('done can reactivate to running', () => {
      const state = { ...base(), status: 'done' as const };
      const next = activate(state);
      expect(next.status).toBe('running');
      expect(next.enabled).toBe(true);
    });
  });

  describe('counters', () => {
    it('incrementTurn increases turnAttempts by 1', () => {
      const state = { ...base(), turnAttempts: 2 };
      expect(incrementTurn(state).turnAttempts).toBe(3);
    });

    it('incrementTotal increases totalContinuations by 1', () => {
      const state = { ...base(), totalContinuations: 10 };
      expect(incrementTotal(state).totalContinuations).toBe(11);
    });

    it('resetTurnAttempts sets turnAttempts to 0', () => {
      const state = { ...base(), turnAttempts: 5 };
      expect(resetTurnAttempts(state).turnAttempts).toBe(0);
    });
  });

  describe('goal management', () => {
    it('setGoal sets goal and truncates at 500 chars', () => {
      const state = base();
      const next = setGoal(state, 'A'.repeat(1000));
      expect(next.goal).toBe('A'.repeat(500));
    });

    it('setGoal updates existing goal (GAP-29 upsert)', () => {
      const state = { ...base(), goal: 'existing goal' };
      const next = setGoal(state, 'new goal');
      expect(next.goal).toBe('new goal');
    });

    it('setGoal truncates updated goal at 500 chars', () => {
      const state = { ...base(), goal: 'short' };
      const next = setGoal(state, 'B'.repeat(600));
      expect(next.goal).toBe('B'.repeat(500));
    });

    it('snapshotGoal saves goal and progress to snapshot fields', () => {
      const state = { ...base(), goal: 'my goal', progress: 'step 3 done' };
      const next = snapshotGoal(state);
      expect(next.goalSnapshot).toBe('my goal');
      expect(next.progressSnapshot).toBe('step 3 done');
    });

    it('restoreGoalFromSnapshot restores goal from snapshot when goal is lost', () => {
      const state = { ...base(), goal: undefined, goalSnapshot: 'saved goal', progressSnapshot: 'saved progress' };
      const next = restoreGoalFromSnapshot(state);
      expect(next.goal).toBe('saved goal');
      expect(next.progress).toBe('saved progress');
    });

    it('restoreGoalFromSnapshot keeps existing goal but still restores progress', () => {
      const state = { ...base(), goal: 'current', progress: undefined, goalSnapshot: 'old', progressSnapshot: 'saved progress' };
      const next = restoreGoalFromSnapshot(state);
      expect(next.goal).toBe('current');
      expect(next.progress).toBe('saved progress');
    });

    // M1: restoreGoalFromSnapshot uses ?? for goal (nullish coalescing, not falsy)
    it('restoreGoalFromSnapshot uses ?? semantics — empty goal is preserved, not replaced', () => {
      const state = { ...base(), goal: '', goalSnapshot: 'saved goal', progressSnapshot: 'saved progress' };
      const next = restoreGoalFromSnapshot(state);
      // With ??, '' is not nullish so it is preserved (not replaced by snapshot).
      // This is correct — setGoal trims and won't produce '', so '' shouldn't occur.
      expect(next.goal).toBe('');
      expect(next.progress).toBe('saved progress');
    });

    it('restoreGoalFromSnapshot falls back to snapshot when goal is undefined', () => {
      const state = { ...base(), goal: undefined, goalSnapshot: 'saved goal', progressSnapshot: 'saved progress' };
      const next = restoreGoalFromSnapshot(state);
      expect(next.goal).toBe('saved goal');
      expect(next.progress).toBe('saved progress');
    });
  });
});
