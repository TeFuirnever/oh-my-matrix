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
  buildRetryEntry,
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

    it('E3: a bare "timeout" message is NOT auto-recoverable (substring was the bug)', () => {
      // Pre-E3 `includes('timeout')` made any timeout-bearing string recoverable,
      // mis-classifying paths/messages. Recovery now needs a network errno
      // (ETIMEDOUT), not the bare word. A generic process timeout is unknown →
      // conservative non-recoverable.
      expect(classifyRecoverability('agent process timeout')).toEqual<RetryClassification>({
        recoverable: false,
        category: 'unknown',
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

// E3: explicit classification table — structured/anchored matching.
describe('E3: classifyRecoverability — rate-limit / overload / network / auth', () => {
  it('HTTP 429 / "rate limit" → recoverable + long backoff tier', () => {
    for (const s of ['429 Too Many Requests', 'rate limit exceeded', 'RATE_LIMIT hit']) {
      const r = classifyRecoverability(s);
      expect(r.recoverable).toBe(true);
      expect(r.category).toBe('rate_limit');
      expect(r.backoffTier).toBe('long');
    }
  });

  it('respects an advertised Retry-After (parses seconds)', () => {
    const r = classifyRecoverability('429 with Retry-After: 45');
    expect(r.recoverable).toBe(true);
    expect(r.category).toBe('rate_limit');
    expect(r.retryAfterSec).toBe(45);
  });

  it('HTTP 529 / "overloaded" → recoverable + long backoff tier', () => {
    expect(classifyRecoverability('Error 529 service overloaded')).toEqual<RetryClassification>({
      recoverable: true, category: 'overloaded', backoffTier: 'long',
    });
    expect(classifyRecoverability('the API is overloaded')).toEqual<RetryClassification>({
      recoverable: true, category: 'overloaded', backoffTier: 'long',
    });
  });

  it('network errno codes (ECONNRESET/ETIMEDOUT/EPIPE/socket hang up) → recoverable', () => {
    for (const s of ['ECONNRESET', 'request ETIMEDOUT', 'write EPIPE', 'socket hang up', 'ECONNREFUSED 127.0.0.1:8080']) {
      const r = classifyRecoverability(s);
      expect(r.recoverable).toBe(true);
      expect(r.category).toBe('network');
    }
  });

  it('E3 fix: a "tokenizer error" is NOT budget (bare "token" was the bug)', () => {
    const r = classifyRecoverability('tokenizer error: unknown token');
    expect(r.category).not.toBe('budget');
    expect(r.recoverable).toBe(false); // unknown, conservative
  });

  it('token_budget_exceeded is STILL budget (anchored compound)', () => {
    expect(classifyRecoverability('token_budget_exceeded').category).toBe('budget');
  });

  it('auth 401/403 → non-recoverable', () => {
    expect(classifyRecoverability('401 unauthorized')).toEqual<RetryClassification>({
      recoverable: false, category: 'auth',
    });
    expect(classifyRecoverability('403 forbidden').category).toBe('auth');
  });

  it('context_length_exceeded → recoverable (one-shot); max_tokens is NOT (review follow-up)', () => {
    expect(classifyRecoverability('context_length_exceeded').recoverable).toBe(true);
    expect(classifyRecoverability('context_length_exceeded').category).toBe('context_overflow');
    // max_tokens is the OUTPUT-length stop reason: retrying re-runs the same
    // prompt against the same output cap (wasted tokens), and compaction does
    // nothing for an output cap. So it falls through to unknown (non-recoverable),
    // terminating instead of looping.
    const mt = classifyRecoverability('hit max_tokens limit');
    expect(mt.category).not.toBe('context_overflow');
    expect(mt.recoverable).toBe(false);
  });

  it('a bare Retry-After no longer triggers rate_limit (review follow-up: no shadowing)', () => {
    // A non-recoverable error carrying Retry-After must hit its own bucket, not
    // be shadowed into recoverable rate_limit.
    const r = classifyRecoverability('permission denied (retry-after: 30)');
    expect(r.recoverable).toBe(false);
    expect(r.category).toBe('permission');
    // Bare Retry-After with no 429/rate-limit signal → unknown, not rate_limit.
    expect(classifyRecoverability('retry-after: 30').category).not.toBe('rate_limit');
  });

  it('HTTP status embedded in a URL path does not false-positive (review follow-up)', () => {
    expect(classifyRecoverability('GET https://api.x/429/logs failed').category).not.toBe('rate_limit');
    expect(classifyRecoverability('connect ECONNREFUSED port 4290').category).toBe('network');
  });

  it('rate-limit wins over a "validation" substring in the same string', () => {
    // Precedence: structured rate-limit must beat the domain bucket.
    expect(classifyRecoverability('429 validation retry').category).toBe('rate_limit');
  });

  it('a port-like number does not false-positive a status (e.g. port 4290)', () => {
    expect(classifyRecoverability('connect ECONNREFUSED port 4290').category).toBe('network');
  });
});

describe('E3: computeRetryDelay — tier, jitter, Retry-After', () => {
  it('default tier stays deterministic (no opts) — backward compat', () => {
    expect(computeRetryDelay(1, 300000)).toBe(10000);
    expect(computeRetryDelay(3, 300000)).toBe(40000);
  });

  it('long tier scales the base (rate-limit / overload wait longer)', () => {
    // 10000 * 2^(1-1) * 4 = 40000
    expect(computeRetryDelay(1, 300000, { tier: 'long' })).toBe(40000);
  });

  it('honors server Retry-After when larger than computed delay', () => {
    // computed attempt-1 default = 10000; Retry-After 60s → 60000 (under cap).
    expect(computeRetryDelay(1, 300000, { retryAfterMs: 60_000 })).toBe(60_000);
    // Retry-After never exceeds the cap.
    expect(computeRetryDelay(1, 300000, { retryAfterMs: 999_999 })).toBe(300000);
  });

  it('jitter spreads ±fraction deterministically with a fixed rng', () => {
    // delay=10000, jitter=0.2 → delta=2000, range [8000,12000].
    // rng()=0 → 8000; rng()=1 → 12000; rng()=0.5 → 10000.
    expect(computeRetryDelay(1, 300000, { jitter: 0.2, rng: () => 0 })).toBe(8000);
    expect(computeRetryDelay(1, 300000, { jitter: 0.2, rng: () => 1 })).toBe(12000);
    expect(computeRetryDelay(1, 300000, { jitter: 0.2, rng: () => 0.5 })).toBe(10000);
  });

  it('jitter never exceeds the cap', () => {
    // attempt 10 default caps at 300000; even rng=1 stays at cap.
    expect(computeRetryDelay(10, 300000, { jitter: 0.2, rng: () => 1 })).toBe(300000);
  });

  it('jitter never drops below an honored Retry-After (review follow-up)', () => {
    // delay raised to retryAfterMs=60000; jitter rng=0 would give 48000, but the
    // server asked for 60s — floor at retryAfterMs.
    expect(computeRetryDelay(1, 300000, { jitter: 0.2, rng: () => 0, retryAfterMs: 60_000 })).toBe(60_000);
    // rng=1 still spreads upward.
    expect(computeRetryDelay(1, 300000, { jitter: 0.2, rng: () => 1, retryAfterMs: 60_000 })).toBe(72_000);
  });
});

describe('E3: buildRetryEntry — threads classification tier + jitter', () => {
  it('rate-limit error → long-tier backoff in the entry', () => {
    const entry = buildRetryEntry(1, '429 rate limit', 1000, 300000, { jitter: 0, rng: () => 0.5 });
    expect(entry.recoverable).toBe(true);
    // long tier attempt 1 = 40000
    expect(entry.nextRetryAt).toBe(1000 + 40000);
  });

  it('honors Retry-After from the classification', () => {
    const entry = buildRetryEntry(1, '429 Retry-After: 90', 1000, 300000, { jitter: 0, rng: () => 0.5 });
    // 90s > 40s long-tier base → 90000
    expect(entry.nextRetryAt).toBe(1000 + 90_000);
  });

  it('jitter=0 (default) is deterministic', () => {
    const a = buildRetryEntry(2, 'transient', 0, 300000);
    const b = buildRetryEntry(2, 'transient', 0, 300000);
    expect(a.nextRetryAt).toBe(b.nextRetryAt);
    expect(a.nextRetryAt).toBe(20000); // attempt 2 default = 20000
  });
});
