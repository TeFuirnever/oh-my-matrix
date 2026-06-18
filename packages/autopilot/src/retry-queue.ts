/**
 * M2.5 Retry Queue
 *
 * Exponential backoff calculator and recoverable error classifier.
 * Pure functions — no side effects.
 */
import type { RetryEntry } from './types';

/** delay = min(10000 * 2^(attempt-1), maxRetryBackoffMs) */
export function computeRetryDelay(attempt: number, maxRetryBackoffMs: number): number {
  const base = 10000;
  const delay = base * Math.pow(2, attempt - 1);
  return Math.min(delay, maxRetryBackoffMs);
}

export interface RetryClassification {
  recoverable: boolean;
  category: string;
}

/** Classify an error string into recoverable vs non-recoverable */
export function classifyRecoverability(error: string): RetryClassification {
  const lower = error.toLowerCase();

  // Recoverable errors
  if (lower.includes('transient') || lower.includes('tool fail')) {
    return { recoverable: true, category: 'transient_error' };
  }
  if (lower.includes('timeout')) {
    return { recoverable: true, category: 'timeout' };
  }
  if (lower === 'stalled' || lower.includes('stall')) {
    return { recoverable: true, category: 'stall' };
  }

  // Non-recoverable: permission must be checked BEFORE validation/injection
  // so that mixed messages like "permission validation_failed" or
  // "permission injection rejected" are always non-recoverable.
  if (lower.includes('permission')) {
    return { recoverable: false, category: 'permission' };
  }

  if (lower.includes('validation_failed') || lower.includes('validation')) {
    return { recoverable: true, category: 'validation' };
  }

  if (lower.includes('injection') || lower.includes('rejected')) {
    return { recoverable: true, category: 'injection_rejected' };
  }

  // Non-recoverable errors
  if (lower.includes('containment') || lower.includes('workspace_create')) {
    return { recoverable: false, category: 'workspace' };
  }
  // config_invalid or any error starting with 'config' — but NOT 'reconfiguration...'
  // which is a transient state change, not a config error.
  if (lower.startsWith('config')) {
    return { recoverable: false, category: 'config' };
  }
  if (lower.includes('budget') || lower.includes('token')) {
    return { recoverable: false, category: 'budget' };
  }
  if (lower.includes('user_stopped') || lower === 'user stopped') {
    return { recoverable: false, category: 'user_action' };
  }
  if (lower.includes('max_retries')) {
    return { recoverable: false, category: 'max_retries' };
  }

  // Unknown errors — treat as non-recoverable for safety
  return { recoverable: false, category: 'unknown' };
}

export interface ShouldRetryInput {
  attempt: number;
  maxRetries: number;
  recoverable: boolean;
}

/** Determine whether a retry should be attempted */
export function shouldRetry(input: ShouldRetryInput): boolean {
  if (!input.recoverable) return false;
  if (input.maxRetries <= 0) return false;
  return input.attempt <= input.maxRetries;
}

/** Build a RetryEntry for the next retry attempt */
export function buildRetryEntry(
  attempt: number,
  error: string,
  now: number,
  maxRetryBackoffMs: number,
): RetryEntry {
  const classification = classifyRecoverability(error);
  return {
    attempt,
    nextRetryAt: now + computeRetryDelay(attempt, maxRetryBackoffMs),
    lastError: error,
    recoverable: classification.recoverable,
  };
}
