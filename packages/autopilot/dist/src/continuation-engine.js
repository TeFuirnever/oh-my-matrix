"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideContinuation = decideContinuation;
exports.buildRetryInstruction = buildRetryInstruction;
const completion_detector_1 = require("./completion-detector");
const tool_error_tracker_1 = require("./tool-error-tracker");
/**
 * P1-2: Minimum number of cross-turn continuations that must elapse before a
 * textual completion signal (isTaskComplete) is trusted as 'complete'.
 *
 * Opening/mid-run summary phrasing ("所有任务已完成" / "all tasks completed") can
 * fire on the very first turn and historically terminated long runs early.
 * Requiring this many continuations forces the model to keep producing work
 * (and evidence) before it is allowed to stop. Raise for stricter safety,
 * lower for snappier simple-task handling.
 */
const MIN_TURNS_BEFORE_COMPLETE = 2;
function decideContinuation(state, event) {
    if (!state.enabled || state.status !== 'running') {
        return { action: 'finalize' };
    }
    if (event.stopHookActive) {
        return { action: 'finalize' };
    }
    if ((0, completion_detector_1.isTaskComplete)(event.lastAssistantMessage, event.stopHookActive)) {
        // P1-2: don't trust an early completion signal. If too few continuations
        // have elapsed, demote to revise so the run continues and the model can
        // demonstrate concrete progress before being allowed to complete.
        if (state.totalContinuations < MIN_TURNS_BEFORE_COMPLETE) {
            return {
                action: 'revise',
                retryInstruction: '[Autopilot] An early completion signal was detected. If the task is genuinely done, briefly state the concrete changes made; otherwise continue from where you left off. (early-completion guard)',
            };
        }
        return { action: 'complete' };
    }
    // Non-task message (greetings like "你好", chit-chat, or the model stating it
    // has nothing to act on): complete immediately. This BYPASSES
    // MIN_TURNS_BEFORE_COMPLETE on purpose — forcing extra continuation turns on a
    // message with no task is exactly the token-wasting loop we are fixing. The
    // patterns in hasNoActionableTask are high-precision (help-offers / explicit
    // no-task) so genuine task progress is not falsely stopped.
    if ((0, completion_detector_1.hasNoActionableTask)(event.lastAssistantMessage)) {
        return { action: 'complete' };
    }
    if ((0, tool_error_tracker_1.isThresholdExceeded)(state, state.toolErrorThreshold)) {
        return { action: 'pause', pauseReason: 'tool_error_repeated' };
    }
    if (state.tokenBudget != null && state.totalTokensUsed >= state.tokenBudget) {
        return { action: 'pause', pauseReason: 'token_budget_exceeded' };
    }
    if (state.totalContinuations >= state.maxTotalContinuations) {
        return { action: 'pause', pauseReason: 'max_total_reached' };
    }
    if (state.turnAttempts >= state.maxAttemptsPerTurn) {
        return { action: 'cross_turn' };
    }
    return {
        action: 'revise',
        retryInstruction: buildRetryInstruction(state),
    };
}
const MAX_INSTRUCTION_LENGTH = 2000;
function buildRetryInstruction(state) {
    const goal = state.goal?.substring(0, 500) || '继续执行当前任务';
    const progress = state.progress?.substring(0, 500) || '';
    // Agent-facing instructions (not user-visible) — intentionally bypass i18n.
    // English is used for better model comprehension across all language settings.
    const parts = [`[Autopilot] Current goal: ${goal}`];
    if (progress) {
        parts.push(`[Autopilot] Progress so far: ${progress}`);
    }
    parts.push('[Autopilot] Continue from where you left off.');
    return parts.join('\n').substring(0, MAX_INSTRUCTION_LENGTH);
}
//# sourceMappingURL=continuation-engine.js.map