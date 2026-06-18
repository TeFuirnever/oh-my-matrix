"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeRetryDelay = computeRetryDelay;
exports.classifyRecoverability = classifyRecoverability;
exports.shouldRetry = shouldRetry;
exports.buildRetryEntry = buildRetryEntry;
/** delay = min(10000 * 2^(attempt-1), maxRetryBackoffMs) */
function computeRetryDelay(attempt, maxRetryBackoffMs) {
    const base = 10000;
    const delay = base * Math.pow(2, attempt - 1);
    return Math.min(delay, maxRetryBackoffMs);
}
/** Classify an error string into recoverable vs non-recoverable */
function classifyRecoverability(error) {
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
/** Determine whether a retry should be attempted */
function shouldRetry(input) {
    if (!input.recoverable)
        return false;
    if (input.maxRetries <= 0)
        return false;
    return input.attempt <= input.maxRetries;
}
/** Build a RetryEntry for the next retry attempt */
function buildRetryEntry(attempt, error, now, maxRetryBackoffMs) {
    const classification = classifyRecoverability(error);
    return {
        attempt,
        nextRetryAt: now + computeRetryDelay(attempt, maxRetryBackoffMs),
        lastError: error,
        recoverable: classification.recoverable,
    };
}
//# sourceMappingURL=retry-queue.js.map