"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUTOPILOT_OUTPUT_COST_PER_M_USD = exports.AUTOPILOT_INPUT_COST_PER_M_USD = void 0;
exports.projectState = projectState;
/**
 * Claude API pricing constants used for cost estimation.
 * Model: Claude Sonnet (as of 2026-Q2). Update if model/pricing changes.
 * Source: https://www.anthropic.com/pricing
 */
exports.AUTOPILOT_INPUT_COST_PER_M_USD = 3.0;
exports.AUTOPILOT_OUTPUT_COST_PER_M_USD = 15.0;
// Claude Sonnet pricing (per 1M tokens, USD)
const INPUT_COST_PER_M = exports.AUTOPILOT_INPUT_COST_PER_M_USD;
const OUTPUT_COST_PER_M = exports.AUTOPILOT_OUTPUT_COST_PER_M_USD;
function projectState(state) {
    if (!state)
        return undefined;
    const now = Date.now();
    const inputTokens = state.inputTokensUsed ?? 0;
    const outputTokens = state.outputTokensUsed ?? 0;
    const estimatedCostUsd = (inputTokens * INPUT_COST_PER_M + outputTokens * OUTPUT_COST_PER_M) / 1_000_000;
    return {
        status: state.status,
        enabled: state.enabled,
        turnAttempts: state.turnAttempts,
        totalContinuations: state.totalContinuations,
        maxAttemptsPerTurn: state.maxAttemptsPerTurn,
        maxTotalContinuations: state.maxTotalContinuations,
        maxConcurrentAutopilot: state.maxConcurrentAutopilot,
        pauseReason: state.pauseReason,
        needsCrossTurnResume: state.needsCrossTurnResume,
        canStop: state.status === 'running' || state.status === 'paused' || state.status === 'done',
        lastGoal: state.goal && state.goal.length > 100 ? state.goal.substring(0, 97) + '...' : state.goal?.substring(0, 100),
        totalTokensUsed: state.totalTokensUsed,
        tokenBudget: state.tokenBudget,
        estimatedCostUsd,
        lastToolError: state.lastToolError,
        degraded: state.degraded,
        // M2 projection fields
        orchestrationState: state.orchestrationState,
        workspacePath: state.workspace?.path,
        workspaceBranch: state.workspace?.branchName,
        retryCount: state.retry?.attempt ?? 0,
        nextRetryAt: state.retry?.nextRetryAt,
        blockedReason: state.blockedReason,
        startedAt: state.startedAt,
        lastActivityAt: state.lastActivityAt,
        runtimeMs: state.startedAt != null ? now - state.startedAt : 0,
        inputTokensUsed: state.inputTokensUsed ?? 0,
        outputTokensUsed: state.outputTokensUsed ?? 0,
        evidenceStatus: state.evidence?.status,
        evidenceSummary: state.evidence?.diffSummary,
        lastEvidenceCommands: state.evidence?.commands,
        workflowSource: state.workflow?.source,
        workflowConfigError: state.workflowConfigError,
    };
}
//# sourceMappingURL=projection.js.map