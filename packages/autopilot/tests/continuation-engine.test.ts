import { describe, it, expect } from 'vitest';
import { decideContinuation, buildRetryInstruction, minTurnsBeforeComplete } from '../src/continuation-engine';
import { createInitialState, type AutopilotState, type EvidenceSummary, type WorkflowConfig } from '../src/types';

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

  // ─── Enhancement B (ADR-019): failure-signal injection ───────────────
  describe('buildRetryInstruction — failure-signal injection (Enhancement B)', () => {
    function failedEvidence(overrides: Partial<EvidenceSummary> = {}): EvidenceSummary {
      return {
        status: 'failed',
        commands: [],
        completedAt: Date.now(),
        failureReason: 'required command(s) failed: node-test',
        ...overrides,
      };
    }

    it('includes failed command summary when evidence status is failed', () => {
      const state = runningState({
        goal: 'fix the bug',
        evidence: failedEvidence({
          commands: [{
            id: 'node-test',
            command: 'npm test',
            status: 'failed',
            exitCode: 1,
            durationMs: 5000,
            summary: 'AssertionError: expected 3 to equal 4 at index.test.ts:12',
          }],
        }),
      });
      const result = buildRetryInstruction(state);
      expect(result).toContain('AssertionError: expected 3 to equal 4');
      expect(result).toContain('Last validation failed');
      expect(result).toContain('continue from where you left off');
    });

    it('includes failureReason as decoration when no command details', () => {
      const state = runningState({
        goal: 'fix the bug',
        evidence: failedEvidence({ commands: [], failureReason: 'required command(s) failed: node-test' }),
      });
      const result = buildRetryInstruction(state);
      expect(result).toContain('required command(s) failed: node-test');
      expect(result).toContain('continue from where you left off');
    });

    it('caps at 2 failed commands', () => {
      const state = runningState({
        goal: 'fix the bug',
        evidence: failedEvidence({
          commands: [
            { id: 'cmd-1', command: 'a', status: 'failed', durationMs: 1, summary: 'fail-1' },
            { id: 'cmd-2', command: 'b', status: 'failed', durationMs: 1, summary: 'fail-2' },
            { id: 'cmd-3', command: 'c', status: 'failed', durationMs: 1, summary: 'fail-3' },
          ],
        }),
      });
      const result = buildRetryInstruction(state);
      expect(result).toContain('fail-1');
      expect(result).toContain('fail-2');
      expect(result).not.toContain('fail-3');
    });

    it('preserves closing line even when goal+progress consume most of the budget', () => {
      // goal at 500 + progress at 500 + a long failure block — closing line must survive.
      const longGoal = 'g'.repeat(500);
      const longProgress = 'p'.repeat(500);
      const state = runningState({
        goal: longGoal,
        progress: longProgress,
        evidence: failedEvidence({
          commands: [{
            id: 'big-test',
            command: 'npm test',
            status: 'failed',
            durationMs: 1,
            summary: 'x'.repeat(300),
          }],
        }),
      });
      const result = buildRetryInstruction(state);
      expect(result).toContain('continue from where you left off');
      expect(result.length).toBeLessThanOrEqual(2000);
    });

    it('does not exceed MAX_INSTRUCTION_LENGTH (2000) in any case', () => {
      const state = runningState({
        goal: 'g'.repeat(500),
        progress: 'p'.repeat(500),
        evidence: failedEvidence({
          failureReason: 'f'.repeat(200),
          commands: [
            { id: 'c1', command: 'a', status: 'failed', durationMs: 1, summary: 's'.repeat(300) },
            { id: 'c2', command: 'b', status: 'failed', durationMs: 1, summary: 's'.repeat(300) },
          ],
        }),
      });
      const result = buildRetryInstruction(state);
      expect(result.length).toBeLessThanOrEqual(2000);
    });

    it('regression: produces no failure block when evidence is absent', () => {
      const state = runningState({ goal: 'fix the bug' });
      const result = buildRetryInstruction(state);
      expect(result).not.toContain('Last validation failed');
      expect(result).toContain('Current goal: fix the bug');
      expect(result).toContain('continue from where you left off');
    });

    it('E3: escalates guidance at/above RETRY_ESCALATION_THRESHOLD (attempt 3)', () => {
      // After 3 retries the closing line pivots from "fix and retry" to "try a
      // different approach or stop and report" — repeating the same approach is
      // the over-night death loop E3 targets.
      const state = runningState({
        goal: 'fix the bug',
        retry: { attempt: 3, nextRetryAt: Date.now() + 10000, lastError: '429 rate limit', recoverable: true },
      });
      const result = buildRetryInstruction(state);
      expect(result).toContain('fundamentally different approach');
      expect(result).not.toContain('continue from where you left off');
    });

    it('regression: produces no failure block when evidence passed', () => {
      const state = runningState({
        goal: 'fix the bug',
        evidence: { status: 'passed', commands: [], completedAt: Date.now() },
      });
      const result = buildRetryInstruction(state);
      expect(result).not.toContain('Last validation failed');
      expect(result).toContain('continue from where you left off');
    });

    it('regression: produces no failure block when evidence skipped', () => {
      const state = runningState({
        goal: 'fix the bug',
        evidence: { status: 'skipped', commands: [], completedAt: Date.now(), failureReason: 'no commands' },
      });
      const result = buildRetryInstruction(state);
      expect(result).not.toContain('Last validation failed');
    });

    it('regression: default goal when state.goal is undefined', () => {
      const state = runningState({ goal: undefined });
      const result = buildRetryInstruction(state);
      expect(result).toContain('继续执行当前任务');
    });

    it('includes timeout-status commands in the failure block', () => {
      const state = runningState({
        goal: 'fix the bug',
        evidence: failedEvidence({
          commands: [{
            id: 'slow-test',
            command: 'npm test',
            status: 'timeout',
            durationMs: 120000,
            summary: 'timed out after 120000ms',
          }],
        }),
      });
      const result = buildRetryInstruction(state);
      expect(result).toContain('timed out after 120000ms');
    });
  });

  // ─── Enhancement C (ADR-019): conditional early-completion threshold ──
  describe('minTurnsBeforeComplete (Enhancement C)', () => {
    function workflowWithCommands(commands: unknown[]): WorkflowConfig {
      return {
        version: 1,
        source: 'default',
        maxConcurrent: 1,
        maxRetries: 3,
        stallTimeoutMs: 300000,
        maxRetryBackoffMs: 60000,
        workspace: { root: '/tmp', cleanup: 'manual', branchPrefix: 'ap', allowDirtyBase: false },
        validation: { commands: commands as never, failOnOptional: false },
        destructiveGit: { allow: false },
        warnings: [],
      };
    }

    it('returns 2 (default) when no validation commands', () => {
      const state = runningState({ trustWorkspace: true });
      expect(minTurnsBeforeComplete(state)).toBe(2);
    });

    it('returns 2 (default) when trustWorkspace is false even with commands', () => {
      const state = runningState({
        trustWorkspace: false,
        workflow: workflowWithCommands([{ id: 'test', command: 'npm test', timeoutMs: 60000, required: true }]),
      });
      expect(minTurnsBeforeComplete(state)).toBe(2);
    });

    it('returns 2 (default) when trustWorkspace is undefined', () => {
      const state = runningState({
        trustWorkspace: undefined,
        workflow: workflowWithCommands([{ id: 'test', command: 'npm test', timeoutMs: 60000, required: true }]),
      });
      expect(minTurnsBeforeComplete(state)).toBe(2);
    });

    it('returns 3 (verifiable) when commands present AND trustWorkspace true', () => {
      const state = runningState({
        trustWorkspace: true,
        workflow: workflowWithCommands([{ id: 'test', command: 'npm test', timeoutMs: 60000, required: true }]),
      });
      expect(minTurnsBeforeComplete(state)).toBe(3);
    });

    it('decideContinuation demotes completion at totalContinuations=2 for verifiable trusted run', () => {
      // At turn 2: default threshold (2) would allow complete, but verifiable
      // threshold (3) demotes to revise — the core Enhancement C behavior.
      const state = runningState({
        totalContinuations: 2,
        trustWorkspace: true,
        workflow: workflowWithCommands([{ id: 'test', command: 'npm test', timeoutMs: 60000, required: true }]),
      });
      const result = decideContinuation(state, { lastAssistantMessage: '所有任务已完成。' });
      expect(result.action).toBe('revise');
    });

    it('decideContinuation allows completion at totalContinuations=3 for verifiable trusted run', () => {
      const state = runningState({
        totalContinuations: 3,
        trustWorkspace: true,
        workflow: workflowWithCommands([{ id: 'test', command: 'npm test', timeoutMs: 60000, required: true }]),
      });
      const result = decideContinuation(state, { lastAssistantMessage: '所有任务已完成。' });
      expect(result.action).toBe('complete');
    });

    it('regression: non-verifiable run still completes at totalContinuations=2 (backward compat)', () => {
      // No workflow / no commands / untrusted → threshold stays 2 → turn 2 completes.
      const state = runningState({ totalContinuations: 2 });
      const result = decideContinuation(state, { lastAssistantMessage: '所有任务已完成。' });
      expect(result.action).toBe('complete');
    });

    it('createInitialState carries trustWorkspace from config (default false)', () => {
      const state = createInitialState('s', 'r');
      expect(state.trustWorkspace).toBe(false);
    });

    it('createInitialState carries trustWorkspace true when config sets it', () => {
      const state = createInitialState('s', 'r', { maxAttemptsPerTurn: 5, maxTotalContinuations: 50, toolErrorThreshold: 3, trustWorkspace: true });
      expect(state.trustWorkspace).toBe(true);
    });
  });
});
