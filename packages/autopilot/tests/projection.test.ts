import { describe, it, expect } from 'vitest';
import { projectState } from '../src/projection';
import { createInitialState, type AutopilotState } from '../src/types';

describe('projection', () => {
  describe('projectState', () => {
    it('returns undefined for undefined input', () => {
      expect(projectState(undefined)).toBeUndefined();
    });

    it('projects all required fields from state', () => {
      const state: AutopilotState = {
        ...createInitialState('sess-1', 'run-1'),
        status: 'running',
        enabled: true,
        turnAttempts: 2,
        totalContinuations: 10,
        goal: 'refactor auth module',
      };
      const proj = projectState(state)!;
      expect(proj.status).toBe('running');
      expect(proj.enabled).toBe(true);
      expect(proj.turnAttempts).toBe(2);
      expect(proj.totalContinuations).toBe(10);
      expect(proj.maxAttemptsPerTurn).toBe(5);
      expect(proj.maxTotalContinuations).toBe(50);
      expect(proj.lastGoal).toBe('refactor auth module');
    });

    it('canStop is true when running', () => {
      const state = { ...createInitialState('s', 'r'), status: 'running' as const };
      expect(projectState(state)!.canStop).toBe(true);
    });

    it('canStop is true when paused', () => {
      const state = { ...createInitialState('s', 'r'), status: 'paused' as const };
      expect(projectState(state)!.canStop).toBe(true);
    });

    it('canStop is false when idle', () => {
      const state = { ...createInitialState('s', 'r'), status: 'idle' as const };
      expect(projectState(state)!.canStop).toBe(false);
    });

    it('canStop is true when done (user can stop/reset completed autopilot)', () => {
      const state = { ...createInitialState('s', 'r'), status: 'done' as const };
      expect(projectState(state)!.canStop).toBe(true);
    });

    it('truncates goal to 100 chars in projection', () => {
      const state = { ...createInitialState('s', 'r'), goal: 'X'.repeat(500) };
      const result = projectState(state)!.lastGoal!;
      expect(result.length).toBeLessThanOrEqual(100);
    });

    // E-3: truncated goal ends with ellipsis
    it('appends ellipsis when goal is truncated', () => {
      const state = { ...createInitialState('s', 'r'), goal: 'X'.repeat(500) };
      const result = projectState(state)!.lastGoal!;
      expect(result.endsWith('...')).toBe(true);
    });

    it('includes pauseReason when paused', () => {
      const state = {
        ...createInitialState('s', 'r'),
        status: 'paused' as const,
        pauseReason: 'tool_error_repeated' as const,
      };
      expect(projectState(state)!.pauseReason).toBe('tool_error_repeated');
    });

    it('includes needsCrossTurnResume flag', () => {
      const state = { ...createInitialState('s', 'r'), needsCrossTurnResume: true };
      expect(projectState(state)!.needsCrossTurnResume).toBe(true);
    });

    it('projectState includes maxConcurrentAutopilot from state', () => {
      const state = { ...createInitialState('s', 'r'), maxConcurrentAutopilot: 3 };
      expect(projectState(state)!.maxConcurrentAutopilot).toBe(3);
    });

    it('projectState uses default maxConcurrentAutopilot of 5 from createInitialState', () => {
      const state = createInitialState('s', 'r');
      expect(projectState(state)!.maxConcurrentAutopilot).toBe(5);
    });

    // P1 fix: thinkingIntensity must reflect config.thinkingIntensity, not always default 'high'.
    it('thinkingIntensity honors config.thinkingIntensity in implementation phase', () => {
      const state = {
        ...createInitialState('s', 'r'),
        status: 'running' as const,
        totalContinuations: 5, // implementation turn, evidence idle
      };
      expect(projectState(state, { thinkingIntensity: 'medium' })!.thinkingIntensity).toBe('medium');
    });

    it('thinkingIntensity defaults to high when config omitted (backward compat)', () => {
      const state = {
        ...createInitialState('s', 'r'),
        status: 'running' as const,
        totalContinuations: 5,
      };
      expect(projectState(state)!.thinkingIntensity).toBe('high');
    });

    // P1 fix: modelTier/recommendedModelId must reflect plugin-config modelRouting
    // when WORKFLOW.md provides none (mirrors the before_model_resolve hook).
    it('modelTier/recommendedModelId reflect plugin-config modelRouting', () => {
      const state = {
        ...createInitialState('s', 'r'),
        status: 'running' as const,
        totalContinuations: 0, // initial turn -> initialTurnTier 'premium'
      };
      const proj = projectState(state, {
        modelRouting: { defaultTier: 'standard', modelIds: { premium: 'claude-opus-4-8' } },
      })!;
      expect(proj.modelTier).toBe('premium');
      expect(proj.recommendedModelId).toBe('claude-opus-4-8');
    });

    it('recommendedModelId is undefined when no modelRouting configured anywhere', () => {
      const state = {
        ...createInitialState('s', 'r'),
        status: 'running' as const,
        totalContinuations: 0,
      };
      const proj = projectState(state)!;
      expect(proj.modelTier).toBe('premium'); // default initialTurnTier
      expect(proj.recommendedModelId).toBeUndefined();
    });
  });

  describe('canResume projection (T03 / design §3.3)', () => {
    it('true for resumable blocked (evidence_missing)', () => {
      const state = { ...createInitialState('s', 'r'), status: 'paused' as const, orchestrationState: 'blocked' as const, blockedReason: 'evidence_missing' as const };
      expect(projectState(state)!.canResume).toBe(true);
    });

    it('true for resumable blocked (no_progress)', () => {
      const state = { ...createInitialState('s', 'r'), status: 'paused' as const, orchestrationState: 'blocked' as const, blockedReason: 'no_progress' as const };
      expect(projectState(state)!.canResume).toBe(true);
    });

    it('false for terminal blocked (max_total_reached)', () => {
      const state = { ...createInitialState('s', 'r'), status: 'paused' as const, orchestrationState: 'blocked' as const, blockedReason: 'max_total_reached' as const };
      expect(projectState(state)!.canResume).toBe(false);
    });

    it('false when running', () => {
      const state = { ...createInitialState('s', 'r'), status: 'running' as const, orchestrationState: 'claimed' as const };
      expect(projectState(state)!.canResume).toBe(false);
    });
  });
});
