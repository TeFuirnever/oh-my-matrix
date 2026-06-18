/**
 * TDD: token cost mapping — estimatedCostUsd in projection.
 * Written BEFORE implementation.
 */
import { describe, it, expect } from 'vitest';
import { projectState } from '../src/projection';
import type { AutopilotState } from '../src/types';

function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return {
    sessionKey: 'sk-test',
    runId: 'run-test',
    status: 'running',
    enabled: true,
    startedAt: Date.now(),
    totalContinuations: 0,
    turnAttempts: 0,
    totalTokensUsed: 0,
    degraded: false,
    needsCrossTurnResume: false,
    maxAttemptsPerTurn: 5,
    maxTotalContinuations: 20,
    maxConcurrentAutopilot: 5,
    ...overrides,
  } as AutopilotState;
}

describe('projection — estimatedCostUsd', () => {
  it('returns 0 when no tokens used', () => {
    const p = projectState(makeState({ inputTokensUsed: 0, outputTokensUsed: 0 }));
    expect(p?.estimatedCostUsd).toBe(0);
  });

  it('computes cost: input=$3/1M, output=$15/1M', () => {
    const p = projectState(makeState({
      inputTokensUsed: 1_000_000,
      outputTokensUsed: 1_000_000,
    }));
    // 1M * $3/1M + 1M * $15/1M = $3 + $15 = $18
    expect(p?.estimatedCostUsd).toBeCloseTo(18, 4);
  });

  it('only input tokens', () => {
    const p = projectState(makeState({ inputTokensUsed: 500_000, outputTokensUsed: 0 }));
    // 500K * $3/1M = $1.50
    expect(p?.estimatedCostUsd).toBeCloseTo(1.5, 4);
  });

  it('only output tokens', () => {
    const p = projectState(makeState({ inputTokensUsed: 0, outputTokensUsed: 100_000 }));
    // 100K * $15/1M = $1.50
    expect(p?.estimatedCostUsd).toBeCloseTo(1.5, 4);
  });

  it('returns 0 when tokens fields undefined', () => {
    const p = projectState(makeState({ inputTokensUsed: undefined, outputTokensUsed: undefined }));
    expect(p?.estimatedCostUsd).toBe(0);
  });

  it('projection includes estimatedCostUsd field', () => {
    const p = projectState(makeState());
    expect('estimatedCostUsd' in (p ?? {})).toBe(true);
  });
});

describe('projection — LLM prompt strings (R-5 regression)', () => {
  it('buildRetryInstruction output has no Chinese characters', async () => {
    const { buildRetryInstruction } = await import('../src/continuation-engine');
    const state = makeState({ goal: 'Add unit tests', progress: 'Created 3 files' });
    const instruction = buildRetryInstruction(state);
    // No CJK Unicode range characters
    expect(/[一-鿿]/.test(instruction)).toBe(false);
  });
});
