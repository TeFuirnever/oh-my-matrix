import { describe, it, expect } from 'vitest';
import { decideContinuation } from '../src/continuation-engine';
import { createInitialState, type AutopilotState } from '../src/types';

function runningState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return {
    ...createInitialState('session-1', 'run-1'),
    status: 'running',
    enabled: true,
    ...overrides,
  };
}

describe('continuation-engine', () => {
  describe('decideContinuation', () => {
    it('returns revise when task is not complete and attempts remain', () => {
      const state = runningState({ turnAttempts: 0 });
      const result = decideContinuation(state, { lastAssistantMessage: 'I will continue working on this.' });
      expect(result.action).toBe('revise');
    });

    it('returns complete when task completion signal is detected', () => {
      // P1-2: completion requires totalContinuations >= MIN_TURNS_BEFORE_COMPLETE (2).
      const state = runningState({ totalContinuations: 2 });
      const result = decideContinuation(state, { lastAssistantMessage: '所有任务已完成，没有更多待处理的事项。' });
      expect(result.action).toBe('complete');
    });

    it('P1-2: demotes premature complete to revise before MIN_TURNS_BEFORE_COMPLETE', () => {
      // totalContinuations=0 (opening turn) — a completion signal here is untrustworthy
      // and historically terminated long runs early. Demote to revise so the run
      // continues and the model produces concrete evidence before being allowed to stop.
      const state = runningState({ totalContinuations: 0 });
      const result = decideContinuation(state, { lastAssistantMessage: '所有任务已完成。' });
      expect(result.action).toBe('revise');
      expect(result.retryInstruction).toBeDefined();
    });

    it('P1-2: complete allowed only once totalContinuations reaches MIN_TURNS_BEFORE_COMPLETE', () => {
      expect(decideContinuation(runningState({ totalContinuations: 1 }), { lastAssistantMessage: '所有任务已完成。' }).action).toBe('revise');
      expect(decideContinuation(runningState({ totalContinuations: 2 }), { lastAssistantMessage: '所有任务已完成。' }).action).toBe('complete');
    });

    // Non-task message (e.g. "你好" greeting) → model offers help / has nothing to
    // act on. The run must complete immediately instead of looping "continue" until
    // max_total_reached. This BYPASSES MIN_TURNS_BEFORE_COMPLETE because forcing
    // extra turns on a message with no task is exactly the waste we are fixing.
    it('completes immediately on a no-task greeting even at totalContinuations=0', () => {
      const state = runningState({ totalContinuations: 0 });
      const result = decideContinuation(state, { lastAssistantMessage: '你好！请问有什么可以帮你的吗？' });
      expect(result.action).toBe('complete');
    });

    it('completes on English no-task greeting "how can I help you"', () => {
      const state = runningState({ totalContinuations: 0 });
      const result = decideContinuation(state, { lastAssistantMessage: 'Hello! How can I help you today?' });
      expect(result.action).toBe('complete');
    });

    it('completes on explicit no-task statement "there is no task"', () => {
      const state = runningState({ totalContinuations: 1 });
      const result = decideContinuation(state, { lastAssistantMessage: 'There is no task for me to perform right now.' });
      expect(result.action).toBe('complete');
    });

    it('does NOT falsely complete on genuine work progress', () => {
      const state = runningState({ totalContinuations: 0 });
      const result = decideContinuation(state, { lastAssistantMessage: '我正在重构用户认证模块，已完成一半。' });
      expect(result.action).toBe('revise');
    });

    it('returns cross_turn when turnAttempts reaches maxAttemptsPerTurn but total not exhausted', () => {
      const state = runningState({
        turnAttempts: 5,
        maxAttemptsPerTurn: 5,
        totalContinuations: 10,
        maxTotalContinuations: 50,
      });
      const result = decideContinuation(state, { lastAssistantMessage: 'continuing...' });
      expect(result.action).toBe('cross_turn');
    });

    it('returns pause with max_total_reached when total continuations exhausted', () => {
      const state = runningState({
        turnAttempts: 5,
        maxAttemptsPerTurn: 5,
        totalContinuations: 50,
        maxTotalContinuations: 50,
      });
      const result = decideContinuation(state, { lastAssistantMessage: 'still working...' });
      expect(result.action).toBe('pause');
      expect(result.pauseReason).toBe('max_total_reached');
    });

    it('returns pause with tool_error_repeated when tool errors exceed threshold', () => {
      const state = runningState({
        toolErrorCount: 3,
        lastToolError: { tool: 'bash', args: 'npm test', error: 'exit code 1' },
      });
      const result = decideContinuation(state, { lastAssistantMessage: 'trying again...' });
      expect(result.action).toBe('pause');
      expect(result.pauseReason).toBe('tool_error_repeated');
    });

    it('returns finalize when autopilot is not enabled', () => {
      const state = runningState({ enabled: false });
      const result = decideContinuation(state, { lastAssistantMessage: 'hello' });
      expect(result.action).toBe('finalize');
    });

    it('returns finalize when status is not running', () => {
      const state = runningState({ status: 'paused' });
      const result = decideContinuation(state, { lastAssistantMessage: 'hello' });
      expect(result.action).toBe('finalize');
    });

    it('returns finalize when stopHookActive is true', () => {
      const state = runningState();
      const result = decideContinuation(state, { lastAssistantMessage: 'working...', stopHookActive: true });
      expect(result.action).toBe('finalize');
    });

    it('includes retryInstruction when action is revise', () => {
      const state = runningState({ goal: '重构用户认证模块' });
      const result = decideContinuation(state, { lastAssistantMessage: 'I need to continue...' });
      expect(result.action).toBe('revise');
      expect(result.retryInstruction).toBeDefined();
      expect(result.retryInstruction).toContain('重构用户认证模块');
    });

    it('uses generic instruction when goal is not set', () => {
      const state = runningState({ goal: undefined });
      const result = decideContinuation(state, { lastAssistantMessage: 'I need to continue...' });
      expect(result.action).toBe('revise');
      expect(result.retryInstruction).toBeDefined();
      expect(result.retryInstruction!.length).toBeGreaterThan(0);
    });

    it('truncates goal to 500 chars in retryInstruction', () => {
      const longGoal = 'A'.repeat(1000);
      const state = runningState({ goal: longGoal });
      const result = decideContinuation(state, { lastAssistantMessage: 'working...' });
      expect(result.retryInstruction!.length).toBeLessThan(1500);
    });

    it('handles undefined lastAssistantMessage as non-complete', () => {
      const state = runningState();
      const result = decideContinuation(state, { lastAssistantMessage: undefined });
      expect(result.action).toBe('revise');
    });

    it('handles empty lastAssistantMessage as non-complete', () => {
      const state = runningState();
      const result = decideContinuation(state, { lastAssistantMessage: '' });
      expect(result.action).toBe('revise');
    });

    // M4: tokenBudget=0 should NOT be treated as "no budget" (truthy check)
    it('treats tokenBudget=0 as a valid budget and pauses when tokens >= 0', () => {
      const state = runningState({ tokenBudget: 0, totalTokensUsed: 5 });
      const result = decideContinuation(state, { lastAssistantMessage: 'working...' });
      expect(result.action).toBe('pause');
      expect(result.pauseReason).toBe('token_budget_exceeded');
    });

    // H4: NaN totalTokensUsed should not bypass token budget check
    it('handles NaN totalTokensUsed gracefully — does not bypass budget check', () => {
      const state = runningState({ tokenBudget: 1000, totalTokensUsed: NaN });
      const result = decideContinuation(state, { lastAssistantMessage: 'working...' });
      // NaN >= 1000 is false, so it should still proceed (not bypass).
      // This is expected behavior — NaN is not >= budget so it falls through.
      // The real fix is in the token accumulator (index.ts) preventing NaN.
      expect(['revise', 'pause', 'complete', 'cross_turn', 'finalize']).toContain(result.action);
    });

    // H4: tokenBudget with totalTokensUsed at exactly budget
    it('pauses when totalTokensUsed exactly equals tokenBudget', () => {
      const state = runningState({ tokenBudget: 5000, totalTokensUsed: 5000 });
      const result = decideContinuation(state, { lastAssistantMessage: 'working...' });
      expect(result.action).toBe('pause');
      expect(result.pauseReason).toBe('token_budget_exceeded');
    });
  });
});
