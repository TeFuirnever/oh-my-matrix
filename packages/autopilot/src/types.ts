export type AutopilotStatus = 'idle' | 'running' | 'paused' | 'done';

export type PauseReason =
  | 'max_attempts_reached'
  | 'max_total_reached'
  | 'tool_error_repeated'
  | 'loop_breaker_triggered'
  | 'context_overflow_unrecoverable'
  | 'permission_denied'
  | 'injection_rejected'
  | 'user_stopped'
  | 'token_budget_exceeded';

// ─── M2 Orchestration Types ──────────────────────────────────

export type OrchestrationState =
  | 'unclaimed'
  | 'claimed'
  | 'running'
  | 'retry_queued'
  | 'released'
  | 'blocked'
  | 'done';

export type BlockedReason =
  | 'permission_denied'
  | 'workspace_containment_failed'
  | 'workspace_create_failed'
  | 'validation_failed'
  | 'evidence_missing'
  | 'stalled'
  | 'token_budget_exceeded'
  | 'user_stopped'
  | 'config_invalid'
  | 'max_retries_reached';

/** Canonical set of all valid BlockedReason values — used by isValidBlockedReason type guard */
export const VALID_BLOCKED_REASONS: ReadonlySet<BlockedReason> = new Set<BlockedReason>([
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
export function isValidBlockedReason(value: string): value is BlockedReason {
  return VALID_BLOCKED_REASONS.has(value as BlockedReason);
}

/** H-2: Safe BlockedReason coercion — returns the value if valid, otherwise falls back. */
export function toBlockedReason(value: string, fallback: BlockedReason = 'validation_failed'): BlockedReason {
  return isValidBlockedReason(value) ? value : fallback;
}

export type EvidenceStatus = 'not_started' | 'running' | 'passed' | 'failed' | 'skipped';

/**
 * Graduated thinking intensity levels for effort injection.
 * - 'low': standard effort, prefer direct efficient responses
 * - 'medium': moderate extended thinking
 * - 'high': full extended thinking (default, backward compatible)
 */
export type ThinkingIntensity = 'low' | 'medium' | 'high';

/**
 * Model tier for cost-aware routing. Maps to concrete model IDs via
 * ModelRoutingConfig.modelIds. Consumed via before_model_resolve hook.
 * - 'budget': cheapest viable (haiku / deepseek)
 * - 'standard': default balance (sonnet)
 * - 'premium': highest capability (opus)
 *
 * MODEL_TIERS is the single source of truth: the runtime allowlist (used by
 * parseModelRouting / asTier) and the ModelTier union are both derived from
 * it, so adding a tier is a compile-checked one-place edit — no parallel
 * array to keep in sync by hand.
 */
export const MODEL_TIERS = ['budget', 'standard', 'premium'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Model routing configuration. Determines tier per execution phase.
 * If modelIds[tier] is unset, no modelOverride is emitted (inherit declared model).
 */
export interface ModelRoutingConfig {
  /** Required: tier for implementation turns. */
  defaultTier: ModelTier;
  /** Tier for initial turns (totalContinuations <= 1). Default: 'premium'. */
  initialTurnTier?: ModelTier;
  /** Tier for validation turns (evidence.status === 'running'). Default: 'standard'. */
  validationTier?: ModelTier;
  /** Override tier for subagent sessions. Default: fall through to phase logic. */
  subagentTier?: ModelTier;
  /** Map tier -> concrete model ID string (e.g. "claude-opus-4-8"). */
  modelIds?: Partial<Record<ModelTier, string>>;
}

// ─── Shared permission types (now in @oh-my-matrix/permission-policy, ADR-012) ───
// decidePermission + classifyCommand + audit-persister moved to
// @oh-my-matrix/permission-policy; autopilot is now a CONSUMER of those primitives.
// Imported locally (AutopilotState.permissionAudit uses PermissionAuditEntry)
// and re-exported so existing `import type { ... } from './types'` resolves.
import type { CommandClass, PermissionAuditEntry } from '@oh-my-matrix/permission-policy';
export type { CommandClass, PermissionAuditEntry };

export interface WorkspaceRecord {
  root: string;
  path: string;
  workspaceKey: string;
  branchName: string;
  baseBranch: string;
  createdNow: boolean;
  reusable: boolean;
  lastVerifiedAt?: number;
}

export interface RetryEntry {
  attempt: number;
  nextRetryAt: number;
  lastError: string;
  recoverable: boolean;
}

export interface EvidenceCommandResult {
  id: string;
  command: string;
  status: 'passed' | 'failed' | 'timeout' | 'skipped';
  exitCode?: number;
  durationMs: number;
  summary: string;
}

export interface EvidenceSummary {
  status: EvidenceStatus;
  diffSummary?: string;
  commands: EvidenceCommandResult[];
  completedAt?: number;
  failureReason?: string;
}

export interface ValidationCommand {
  id: string;
  command: string;
  timeoutMs: number;
  required: boolean;
}

export interface WorkflowConfig {
  version: 1;
  source: 'workflow_md' | 'default' | 'last_valid';
  maxConcurrent: number;
  maxRetries: number;
  stallTimeoutMs: number;
  maxRetryBackoffMs: number;
  workspace: {
    root: string;
    cleanup: 'manual' | 'delete_on_done';
    branchPrefix: string;
    baseRef?: string;
    allowDirtyBase: boolean;
  };
  validation: {
    commands: ValidationCommand[];
    failOnOptional: boolean;
  };
  destructiveGit: {
    allow: boolean;
  };
  warnings: string[];
  modelRouting?: ModelRoutingConfig;
}

export type OrchestratorEvent =
  | { type: 'activate_requested'; sessionKey: string; goal?: string; now: number }
  | { type: 'workspace_ready'; runId: string; workspace: WorkspaceRecord; now: number }
  | { type: 'workspace_failed'; runId: string; error: string; now: number }
  | { type: 'agent_turn_started'; runId: string; now: number }
  | { type: 'agent_activity'; runId: string; activity: 'llm_output' | 'tool_call' | 'tool_result'; now: number; tokens?: { input?: number; output?: number; total?: number } }
  | { type: 'agent_turn_finished'; runId: string; success: boolean; error?: string; now: number }
  | { type: 'retry_due'; runId: string; now: number }
  | { type: 'stall_timeout'; runId: string; now: number }
  | { type: 'evidence_started'; runId: string; now: number }
  | { type: 'evidence_finished'; runId: string; evidence: EvidenceSummary; now: number }
  | { type: 'permission_denied'; runId: string; toolName: string; now: number }
  | { type: 'stop_requested'; runId: string; now: number }
  | { type: 'resume_requested'; runId: string; now: number };

// ─── Core State ───────────────────────────────────────────────

export interface ToolErrorEntry {
  tool: string;
  args: string;
  error: string;
}

export interface AutopilotState {
  status: AutopilotStatus;
  sessionKey: string;
  runId: string;
  goal?: string;
  goalSnapshot?: string;
  progress?: string;
  progressSnapshot?: string;
  turnAttempts: number;
  totalContinuations: number;
  maxAttemptsPerTurn: number;
  maxTotalContinuations: number;
  maxConcurrentAutopilot: number;
  lastToolError?: ToolErrorEntry;
  toolErrorCount: number;
  toolErrorThreshold: number;
  pauseReason?: PauseReason;
  needsCrossTurnResume: boolean;
  enabled: boolean;
  totalTokensUsed: number;
  tokenBudget?: number;
  degraded: boolean;
  // M2 orchestration fields (all optional for backward compat)
  orchestrationState?: OrchestrationState;
  workspace?: WorkspaceRecord;
  retry?: RetryEntry;
  blockedReason?: BlockedReason;
  startedAt?: number;
  lastActivityAt?: number;
  evidence?: EvidenceSummary;
  workflow?: WorkflowConfig;
  workflowConfigError?: string;
  permissionAudit?: PermissionAuditEntry[];
  inputTokensUsed?: number;
  outputTokensUsed?: number;
}

export interface ContinuationDecision {
  action: 'revise' | 'finalize' | 'cross_turn' | 'pause' | 'complete';
  pauseReason?: PauseReason;
  retryInstruction?: string;
}

export interface AutopilotConfig {
  maxAttemptsPerTurn: number;
  maxTotalContinuations: number;
  toolErrorThreshold: number;
  excludedAgents?: string[];
  highRiskTools?: string[];
  tokenBudget?: number;
  maxConcurrentAutopilot?: number;
  thinkingIntensity?: ThinkingIntensity;
  modelRouting?: ModelRoutingConfig;
  /**
   * S1 residual (audit 2026-06-30): when false/undefined (default), validation
   * commands sourced from WORKFLOW.md or auto-detected from the workspace are
   * NOT executed. An untrusted workspace cannot reach RCE via the evidence gate
   * (this also covers `npm run <tampered script>` / `node evil.js`, which the
   * binary allowlist alone cannot stop). Operators opt in per-activate (payload)
   * or via plugin config to enable workspace-sourced validation.
   */
  trustWorkspace?: boolean;
}

export const DEFAULT_CONFIG: AutopilotConfig = {
  maxAttemptsPerTurn: 5,
  maxTotalContinuations: 50,
  toolErrorThreshold: 3,
  excludedAgents: [],
  maxConcurrentAutopilot: 5,
};

export function createInitialState(
  sessionKey: string,
  runId: string,
  config: AutopilotConfig = DEFAULT_CONFIG,
): AutopilotState {
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

// ─── H-6: OpenClaw Plugin API Contract ────────────────────────────

/** Context for hook event handlers (e.g., ctx.sessionKey, ctx.agentId) */
export interface HookContext {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  workspacePath?: string;
  [key: string]: unknown;
}

/** Gateway respond callback passed to every registerGatewayMethod handler */
export type GatewayRespond = (ok: boolean, data?: unknown, err?: { code: string; message: string }) => void;

/** Destructured context shape received by each registerGatewayMethod handler */
export type GatewayCtx = { params: Record<string, unknown>; respond: GatewayRespond };

/** Result of enqueueNextTurnInjection */
export interface InjectionResult {
  enqueued: boolean;
  reason?: string;
}
