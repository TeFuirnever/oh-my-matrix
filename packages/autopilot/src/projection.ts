import type { AutopilotState, ToolErrorEntry, EvidenceCommandResult, ThinkingIntensity, ModelTier } from './types';
import { resolveThinkingIntensity } from './effort-injection';
import { resolveModelTier, resolveModelId } from './model-routing';

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
  // M2 projection fields (all optional for backward compat)
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
  evidenceStatus?: AutopilotState['evidence'] extends { status: infer S } | undefined ? S : never;
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
export const AUTOPILOT_INPUT_COST_PER_M_USD = 3.0;
export const AUTOPILOT_OUTPUT_COST_PER_M_USD = 15.0;

// Claude Sonnet pricing (per 1M tokens, USD)
const INPUT_COST_PER_M = AUTOPILOT_INPUT_COST_PER_M_USD;
const OUTPUT_COST_PER_M = AUTOPILOT_OUTPUT_COST_PER_M_USD;

export function projectState(state: AutopilotState | undefined): AutopilotProjection | undefined {
  if (!state) return undefined;
  const now = Date.now();
  const inputTokens = state.inputTokensUsed ?? 0;
  const outputTokens = state.outputTokensUsed ?? 0;
  const estimatedCostUsd =
    (inputTokens * INPUT_COST_PER_M + outputTokens * OUTPUT_COST_PER_M) / 1_000_000;
  const modelRouting = state.workflow?.modelRouting;
  const modelTier = state.status === 'running'
    ? resolveModelTier(state.totalContinuations, state.evidence?.status, false, modelRouting)
    : undefined;
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
    thinkingIntensity: state.status === 'running'
      ? resolveThinkingIntensity(state.totalContinuations, state.evidence?.status)
      : undefined,
    modelTier,
    recommendedModelId: modelTier ? resolveModelId(modelTier, modelRouting) : undefined,
  };
}
