import type { AutopilotState, ToolErrorEntry, EvidenceCommandResult, ThinkingIntensity, ModelTier, AutopilotConfig } from './types';
export interface AutopilotProjection {
    status: AutopilotState['status'];
    enabled: boolean;
    turnAttempts: number;
    totalContinuations: number;
    maxAttemptsPerTurn: number;
    maxTotalContinuations: number;
    maxConcurrentAutopilot: number;
    pauseReason?: AutopilotState['pauseReason'];
    needsCrossTurnResume: boolean;
    canStop: boolean;
    lastGoal?: string;
    totalTokensUsed: number;
    tokenBudget?: number;
    /** Estimated API cost in USD based on input/output token counts (Claude Sonnet pricing) */
    estimatedCostUsd: number;
    lastToolError?: ToolErrorEntry;
    degraded: boolean;
    orchestrationState?: AutopilotState['orchestrationState'];
    workspacePath?: string;
    workspaceBranch?: string;
    retryCount?: number;
    nextRetryAt?: number;
    blockedReason?: AutopilotState['blockedReason'];
    startedAt?: number;
    lastActivityAt?: number;
    runtimeMs?: number;
    inputTokensUsed?: number;
    outputTokensUsed?: number;
    evidenceStatus?: AutopilotState['evidence'] extends {
        status: infer S;
    } | undefined ? S : never;
    evidenceSummary?: string;
    lastEvidenceCommands?: EvidenceCommandResult[];
    workflowSource?: 'workflow_md' | 'default' | 'last_valid';
    workflowConfigError?: string;
    /** Current resolved thinking intensity (observability only) */
    thinkingIntensity?: ThinkingIntensity;
    /** Current resolved model tier (observability) */
    modelTier?: ModelTier;
    /** Recommended model ID for current tier (observability) */
    recommendedModelId?: string;
}
/**
 * Claude API pricing constants used for cost estimation.
 * Model: Claude Sonnet (as of 2026-Q2). Update if model/pricing changes.
 * Source: https://www.anthropic.com/pricing
 */
export declare const AUTOPILOT_INPUT_COST_PER_M_USD = 3;
export declare const AUTOPILOT_OUTPUT_COST_PER_M_USD = 15;
export declare function projectState(state: AutopilotState | undefined, config?: Pick<AutopilotConfig, 'thinkingIntensity' | 'modelRouting'>): AutopilotProjection | undefined;
//# sourceMappingURL=projection.d.ts.map