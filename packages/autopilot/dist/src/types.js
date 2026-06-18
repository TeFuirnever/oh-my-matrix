"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = exports.VALID_BLOCKED_REASONS = void 0;
exports.isValidBlockedReason = isValidBlockedReason;
exports.toBlockedReason = toBlockedReason;
exports.createInitialState = createInitialState;
/** Canonical set of all valid BlockedReason values — used by isValidBlockedReason type guard */
exports.VALID_BLOCKED_REASONS = new Set([
    'permission_denied',
    'workspace_containment_failed',
    'workspace_create_failed',
    'validation_failed',
    'evidence_missing',
    'stalled',
    'token_budget_exceeded',
    'user_stopped',
    'config_invalid',
    'max_retries_reached',
]);
/** H-2: Type guard — validates that an arbitrary string is a BlockedReason.
 *  Returns `'validation_failed'` fallback when the string is not a valid reason. */
function isValidBlockedReason(value) {
    return exports.VALID_BLOCKED_REASONS.has(value);
}
/** H-2: Safe BlockedReason coercion — returns the value if valid, otherwise falls back. */
function toBlockedReason(value, fallback = 'validation_failed') {
    return isValidBlockedReason(value) ? value : fallback;
}
exports.DEFAULT_CONFIG = {
    maxAttemptsPerTurn: 5,
    maxTotalContinuations: 50,
    toolErrorThreshold: 3,
    excludedAgents: [],
    maxConcurrentAutopilot: 5,
};
function createInitialState(sessionKey, runId, config = exports.DEFAULT_CONFIG) {
    return {
        status: 'idle',
        sessionKey,
        runId,
        turnAttempts: 0,
        totalContinuations: 0,
        maxAttemptsPerTurn: config.maxAttemptsPerTurn,
        maxTotalContinuations: config.maxTotalContinuations,
        maxConcurrentAutopilot: config.maxConcurrentAutopilot ?? 5,
        toolErrorCount: 0,
        toolErrorThreshold: config.toolErrorThreshold,
        needsCrossTurnResume: false,
        enabled: false,
        totalTokensUsed: 0,
        tokenBudget: config.tokenBudget,
        degraded: false,
    };
}
//# sourceMappingURL=types.js.map