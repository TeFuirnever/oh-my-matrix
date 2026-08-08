import type { AutopilotState, ToolErrorEntry, EvidenceCommandResult, ThinkingIntensity, ModelTier, AutopilotConfig } from './types';
import { resolveThinkingIntensity } from './effort-injection';
import { resolveModelTier, resolveModelId } from './model-routing';
import { getCheckpointWriteFailureCount } from './state-persister';
import { computeCostUsd } from './cost';

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
  /** E8 / P2-18: checkpoint write-failure count (observability only — the run
   * panel was removed, so there is no UI consumer; surfaced for logs/future use).
   * Global counter, identical across sessions. */
  checkpointWriteFailures: number;
  /** E6 dir-1: timestamp a tool/validation is in flight (observability); undefined
   * when idle. While set the stall patrol uses the longer per-tool cap. */
  inFlightToolStartedAt?: number;
}

/**
 * Claude API pricing constants — re-exported from src/cost.ts (the single
 * source of truth, shared with the cost-cap enforcement in index.ts).
 * Model: Claude Sonnet (as of 2026-Q2). Update via cost.ts.
 */
export { AUTOPILOT_INPUT_COST_PER_M_USD, AUTOPILOT_OUTPUT_COST_PER_M_USD } from './cost';

export function projectState(
  state: AutopilotState | undefined,
  // Effective config mirrors before_model_resolve (workflow wins, plugin fallback)
  // so observability fields match actual runtime routing/injection.
  config?: Pick<AutopilotConfig, 'thinkingIntensity' | 'modelRouting'>,
): AutopilotProjection | undefined {
  if (!state) return undefined;
  const now = Date.now();
  const inputTokens = state.inputTokensUsed ?? 0;
  const outputTokens = state.outputTokensUsed ?? 0;
  // E2: cost computed via the shared pure function (src/cost.ts) so the
  // projection and the cost-cap enforcer share one pricing source.
  const estimatedCostUsd = computeCostUsd(inputTokens, outputTokens);
  const modelRouting = state.workflow?.modelRouting ?? config?.modelRouting;
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
      ? resolveThinkingIntensity(state.totalContinuations, state.evidence?.status, config?.thinkingIntensity)
      : undefined,
    modelTier,
    recommendedModelId: modelTier ? resolveModelId(modelTier, modelRouting) : undefined,
    checkpointWriteFailures: getCheckpointWriteFailureCount(),
    inFlightToolStartedAt: state.inFlightToolStartedAt,
  };
}
