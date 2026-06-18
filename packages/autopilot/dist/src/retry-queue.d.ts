/**
 * M2.5 Retry Queue
 *
 * Exponential backoff calculator and recoverable error classifier.
 * Pure functions — no side effects.
 */
import type { RetryEntry } from './types';
/** delay = min(10000 * 2^(attempt-1), maxRetryBackoffMs) */
export declare function computeRetryDelay(attempt: number, maxRetryBackoffMs: number): number;
export interface RetryClassification {
    recoverable: boolean;
    category: string;
}
/** Classify an error string into recoverable vs non-recoverable */
export declare function classifyRecoverability(error: string): RetryClassification;
export interface ShouldRetryInput {
    attempt: number;
    maxRetries: number;
    recoverable: boolean;
}
/** Determine whether a retry should be attempted */
export declare function shouldRetry(input: ShouldRetryInput): boolean;
/** Build a RetryEntry for the next retry attempt */
export declare function buildRetryEntry(attempt: number, error: string, now: number, maxRetryBackoffMs: number): RetryEntry;
//# sourceMappingURL=retry-queue.d.ts.map