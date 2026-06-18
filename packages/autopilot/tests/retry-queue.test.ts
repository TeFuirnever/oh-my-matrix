/**
 * M2.5 TDD Tests: Retry Queue
 *
 * Tests exponential backoff, max retries cap, and recoverable classification.
 */
import { describe, it, expect } from 'vitest';
import {
  computeRetryDelay,
  classifyRecoverability,
  shouldRetry,
  type RetryClassification,
} from '../src/retry-queue';

describe('retry-queue', () => {
  describe('computeRetryDelay', () => {
    it('attempt 1: 10s base delay', () => {
      expect(computeRetryDelay(1, 300000)).toBe(10000);
    });

    it('attempt 2: 20s (2x)', () => {
      expect(computeRetryDelay(2, 300000)).toBe(20000);
    });

    it('attempt 3: 40s (4x)', () => {
      expect(computeRetryDelay(3, 300000)).toBe(40000);
    });

    it('attempt 4: 80s (8x)', () => {
      expect(computeRetryDelay(4, 300000)).toBe(80000);
    });

    it('attempt 5: 160s (16x)', () => {
      expect(computeRetryDelay(5, 300000)).toBe(160000);
    });

    it('capped at maxRetryBackoffMs', () => {
      expect(computeRetryDelay(10, 300000)).toBe(300000);
      expect(computeRetryDelay(20, 300000)).toBe(300000);
    });

    it('respects custom maxRetryBackoffMs', () => {
      expect(computeRetryDelay(5, 50000)).toBe(50000);
    });
  });

  describe('classifyRecoverability', () => {
    it('transient tool error is recoverable', () => {
      expect(classifyRecoverability('transient tool failure')).toEqual<RetryClassification>({
        recoverable: true,
        category: 'transient_error',
      });
    });

    it('agent timeout is recoverable', () => {
      expect(classifyRecoverability('agent process timeout')).toEqual<RetryClassification>({
        recoverable: true,
        category: 'timeout',
      });
    });

    it('stall timeout is recoverable', () => {
      expect(classifyRecoverability('stalled')).toEqual<RetryClassification>({
        recoverable: true,
        category: 'stall',
      });
    });

    it('validation command failed is recoverable', () => {
      expect(classifyRecoverability('validation_failed')).toEqual<RetryClassification>({
        recoverable: true,
        category: 'validation',
      });
    });

    it('injection rejected is recoverable', () => {
      expect(classifyRecoverability('enqueueNextTurnInjection rejected')).toEqual<RetryClassification>({
        recoverable: true,
        category: 'injection_rejected',
      });
    });

    it('permission denied is NOT recoverable', () => {
      expect(classifyRecoverability('permission_denied')).toEqual<RetryClassification>({
        recoverable: false,
        category: 'permission',
      });
    });

    it('workspace containment failed is NOT recoverable', () => {
      expect(classifyRecoverability('workspace_containment_failed')).toEqual<RetryClassification>({
        recoverable: false,
        category: 'workspace',
      });
    });

    it('config invalid is NOT recoverable', () => {
      expect(classifyRecoverability('config_invalid')).toEqual<RetryClassification>({
        recoverable: false,
        category: 'config',
      });
    });

    it('token budget exceeded is NOT recoverable', () => {
      expect(classifyRecoverability('token_budget_exceeded')).toEqual<RetryClassification>({
        recoverable: false,
        category: 'budget',
      });
    });

    it('user stopped is NOT recoverable', () => {
      expect(classifyRecoverability('user_stopped')).toEqual<RetryClassification>({
        recoverable: false,
        category: 'user_action',
      });
    });

    it('max retries reached is NOT recoverable', () => {
      expect(classifyRecoverability('max_retries_reached')).toEqual<RetryClassification>({
        recoverable: false,
        category: 'max_retries',
      });
    });
  });

  describe('shouldRetry', () => {
    it('retry when recoverable and under maxRetries', () => {
      expect(shouldRetry({ attempt: 1, maxRetries: 3, recoverable: true })).toBe(true);
    });

    it('no retry when not recoverable', () => {
      expect(shouldRetry({ attempt: 1, maxRetries: 3, recoverable: false })).toBe(false);
    });

    it('retry when AT maxRetries (attempt === maxRetries is now allowed)', () => {
      expect(shouldRetry({ attempt: 3, maxRetries: 3, recoverable: true })).toBe(true);
    });

    it('no retry when OVER maxRetries', () => {
      expect(shouldRetry({ attempt: 4, maxRetries: 3, recoverable: true })).toBe(false);
      expect(shouldRetry({ attempt: 5, maxRetries: 3, recoverable: true })).toBe(false);
    });

    it('retry at maxRetries - 1', () => {
      expect(shouldRetry({ attempt: 2, maxRetries: 3, recoverable: true })).toBe(true);
    });

    it('zero maxRetries means no retry', () => {
      expect(shouldRetry({ attempt: 0, maxRetries: 0, recoverable: true })).toBe(false);
    });
  });
});

// R-1: permission check must precede injection/rejected check
describe('R-1: classifyRecoverability — permission wins over injection substring', () => {
  it('"permission injection rejected" is non-recoverable (permission check must come first)', () => {
    const result = classifyRecoverability('permission injection rejected');
    expect(result.recoverable).toBe(false);
    expect(result.category).toBe('permission');
  });

  it('"permission denied by policy" is non-recoverable', () => {
    const result = classifyRecoverability('permission denied by policy');
    expect(result.recoverable).toBe(false);
    expect(result.category).toBe('permission');
  });

  it('"injection failed" without permission substring is still recoverable', () => {
    const result = classifyRecoverability('injection failed');
    expect(result.recoverable).toBe(true);
    expect(result.category).toBe('injection_rejected');
  });

  it('"rejected by scheduler" without permission substring is still recoverable', () => {
    const result = classifyRecoverability('rejected by scheduler');
    expect(result.recoverable).toBe(true);
    expect(result.category).toBe('injection_rejected');
  });
});

// S1: permission must win over validation — mixed error strings
describe('S1: classifyRecoverability — permission wins over validation substring', () => {
  it('"permission validation_failed" is non-recoverable (permission check must precede validation)', () => {
    const result = classifyRecoverability('permission validation_failed');
    expect(result.recoverable).toBe(false);
    expect(result.category).toBe('permission');
  });

  it('"permission validation error" is non-recoverable', () => {
    const result = classifyRecoverability('permission validation error');
    expect(result.recoverable).toBe(false);
    expect(result.category).toBe('permission');
  });

  it('"validation_failed" without permission is still recoverable', () => {
    const result = classifyRecoverability('validation_failed');
    expect(result.recoverable).toBe(true);
    expect(result.category).toBe('validation');
  });
});

// S3: config substring must not match transient reconfiguration errors
describe('S3: classifyRecoverability — config match must not catch reconfiguration', () => {
  it('"reconfiguration timeout" is NOT classified as config error', () => {
    const result = classifyRecoverability('reconfiguration timeout');
    expect(result.category).not.toBe('config');
  });

  it('"reconfiguration in progress" is NOT classified as config error', () => {
    const result = classifyRecoverability('reconfiguration in progress');
    expect(result.category).not.toBe('config');
  });

  it('"config_invalid" is still non-recoverable', () => {
    const result = classifyRecoverability('config_invalid');
    expect(result.recoverable).toBe(false);
    expect(result.category).toBe('config');
  });

  it('"config error" exact config phrase is non-recoverable', () => {
    const result = classifyRecoverability('config error');
    expect(result.recoverable).toBe(false);
    expect(result.category).toBe('config');
  });
});
