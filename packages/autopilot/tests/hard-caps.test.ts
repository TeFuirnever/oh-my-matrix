/**
 * E2 unit tests: cost calc, cap detection, four-place reason sync.
 * Pure functions — no plugin registration.
 */
import { describe, it, expect } from 'vitest';
import { computeCostUsd, detectCapExceeded } from '../src/cost';
import { RESUMABLE_BLOCKED_REASONS } from '../src/orchestrator';
import {
  VALID_BLOCKED_REASONS,
  pauseReasonToBlockedReason,
  isValidBlockedReason,
  createInitialState,
} from '../src/types';

describe('E2: computeCostUsd (pure)', () => {
  it('computes Sonnet pricing from input/output tokens', () => {
    // 1M input @ $3 + 0 output = $3
    expect(computeCostUsd(1_000_000, 0)).toBe(3);
    // 1M output @ $15 = $15
    expect(computeCostUsd(0, 1_000_000)).toBe(15);
    // mixed
    expect(computeCostUsd(500_000, 500_000)).toBe(9);
  });

  it('treats NaN/negative as 0 (no spurious cap trip on malformed usage)', () => {
    expect(computeCostUsd(Number.NaN, 100)).toBe(computeCostUsd(0, 100));
    expect(computeCostUsd(-50, -50)).toBe(0);
  });

  it('0/0 → 0 (host not reporting usage yet)', () => {
    expect(computeCostUsd(0, 0)).toBe(0);
  });
});

describe('E2: detectCapExceeded', () => {
  const base = createInitialState('s', 'r');

  it('returns null when no caps configured', () => {
    expect(detectCapExceeded({ ...base, startedAt: 0 }, 9_999_999)).toBeNull();
  });

  it('detects wall-clock cap from startedAt', () => {
    const s = { ...base, maxDurationMs: 60_000, startedAt: 1_000_000 };
    expect(detectCapExceeded(s, 1_059_999)).toBeNull(); // just under
    expect(detectCapExceeded(s, 1_060_000)).toEqual({ reason: 'max_duration_reached' }); // at cap
  });

  it('detects cost cap from reported token usage', () => {
    // 1M output = $15. Cap at $10 → exceeded.
    const s = { ...base, maxCostUsd: 10, inputTokensUsed: 0, outputTokensUsed: 1_000_000 };
    expect(detectCapExceeded(s, 0)).toEqual({ reason: 'max_cost_reached' });
    // under cap
    expect(detectCapExceeded({ ...s, outputTokensUsed: 100_000 }, 0)).toBeNull(); // $1.5 < $10
  });

  it('cost cap is a no-op when host omits usage (tokens stay 0)', () => {
    const s = { ...base, maxCostUsd: 0.01 }; // tiny cap, but no usage reported
    expect(detectCapExceeded(s, 0)).toBeNull();
  });

  it('duration takes precedence over cost when both exceeded', () => {
    const s = {
      ...base,
      maxDurationMs: 60_000, startedAt: 0,
      maxCostUsd: 0.01, inputTokensUsed: 1_000_000, outputTokensUsed: 1_000_000,
    };
    expect(detectCapExceeded(s, 120_000)).toEqual({ reason: 'max_duration_reached' });
  });
});

describe('E2: four-place reason sync', () => {
  it('VALID_BLOCKED_REASONS includes both new reasons (the silent-degrade site)', () => {
    // This is the one place a miss wouldn't compile-error — guard it explicitly.
    expect(VALID_BLOCKED_REASONS.has('max_duration_reached')).toBe(true);
    expect(VALID_BLOCKED_REASONS.has('max_cost_reached')).toBe(true);
  });

  it('isValidBlockedReason accepts the new reasons (no silent fallback)', () => {
    expect(isValidBlockedReason('max_duration_reached')).toBe(true);
    expect(isValidBlockedReason('max_cost_reached')).toBe(true);
  });

  it('pauseReasonToBlockedReason is total for the new reasons (identity)', () => {
    expect(pauseReasonToBlockedReason('max_duration_reached')).toBe('max_duration_reached');
    expect(pauseReasonToBlockedReason('max_cost_reached')).toBe('max_cost_reached');
  });

  it('new BlockedReasons are NOT resumable (aligned with token_budget_exceeded)', () => {
    // Asserting membership here locks the "non-resumable" contract next to the
    // reason set: a hard-cap pause must not be auto-resumable.
    expect(RESUMABLE_BLOCKED_REASONS.has('max_duration_reached')).toBe(false);
    expect(RESUMABLE_BLOCKED_REASONS.has('max_cost_reached')).toBe(false);
  });
});
