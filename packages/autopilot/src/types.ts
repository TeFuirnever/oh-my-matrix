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
  | 'token_budget_exceeded'
  | 'validation_failed'
  // E2: hard caps (wall-clock + cost). Non-resumable, aligned with token_budget_exceeded.
  | 'max_duration_reached'
  | 'max_cost_reached'
  // E6/P0-6 dir-2: activity but no output for N consecutive turns. Resumable
  // (like 'stalled' — recoverable via a user nudge), not terminal.
  | 'no_progress';

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
  | 'max_retries_reached'
  // W1 Phase 1.5: 5 new values so pauseReasonToBlockedReason is total (no fallback).
  // These let terminal PauseReasons map to distinct non-resumable BlockedReasons
  // instead of silently falling through to 'validation_failed' (TENSION 1).
  | 'max_total_reached'
  | 'tool_error_repeated'
  | 'loop_breaker_triggered'
  | 'context_overflow_unrecoverable'
  | 'injection_rejected'
  // W1b: generic terminal error that doesn't match a specific BlockedReason.
  // Non-resumable — prevents lossy toBlockedReason fallback to validation_failed.
  | 'unrecoverable_error'
  // E2: hard-cap terminations (wall-clock + cost). Non-resumable.
  | 'max_duration_reached'
  | 'max_cost_reached'
  // E6/P0-6 dir-2: no files/commands output for N consecutive turns.
  | 'no_progress';

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
  'max_total_reached',
  'tool_error_repeated',
  'loop_breaker_triggered',
  'context_overflow_unrecoverable',
  'injection_rejected',
  'unrecoverable_error',
  'max_duration_reached',
  'max_cost_reached',
  'no_progress',
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

/**
 * W1 Phase 1.5: TOTAL PauseReason → BlockedReason mapping (no silent fallback).
 *
 * Replaces the lossy `toBlockedReason(pauseReason, 'validation_failed')` pattern
 * that mapped 6 of 10 terminal PauseReasons to 'validation_failed' — which is in
 * RESUMABLE_BLOCKED_REASONS, making terminal pauses look recoverable (TENSION 1).
 *
 * This function is total: every PauseReason has an explicit BlockedReason. Adding
 * a new PauseReason without a mapping row is a COMPILE ERROR (not a silent bug).
 */
export function pauseReasonToBlockedReason(reason: PauseReason): BlockedReason {
  switch (reason) {
    case 'permission_denied': return 'permission_denied';
    case 'user_stopped': return 'user_stopped';
    case 'token_budget_exceeded': return 'token_budget_exceeded';
    case 'validation_failed': return 'validation_failed';
    case 'max_attempts_reached': return 'max_retries_reached';
    case 'max_total_reached': return 'max_total_reached';
    case 'tool_error_repeated': return 'tool_error_repeated';
    case 'loop_breaker_triggered': return 'loop_breaker_triggered';
    case 'context_overflow_unrecoverable': return 'context_overflow_unrecoverable';
    case 'injection_rejected': return 'injection_rejected';
    case 'max_duration_reached': return 'max_duration_reached';
    case 'max_cost_reached': return 'max_cost_reached';
    case 'no_progress': return 'no_progress';
  }
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
// E5: progress ledger — structured record of what a run did (files/commands/
// evidence), replacing the "Turn N/M" counter. Type-only import (no runtime cycle).
import type { Ledger } from './progress-ledger';
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
  status: 'passed' | 'failed' | 'timeout' | 'skipped' | 'output_overflow';
  exitCode?: number;
  durationMs: number;
  /**
   * Content contract (code-review 2a): on failure/timeout, carries the
   * truncated stderr/error message (sourced from command-runner.ts:65,
   * `e.stderr ?? e.message ?? String(err)`, capped 300 chars); on pass,
   * empty string. Consumed by buildRetryInstruction (Enhancement B) to
   * re-surface the failure signal into the next retry turn — so changes
   * to this field's content semantics silently affect that injection.
   */
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
  /**
   * E3/P2-18: ±fraction jitter applied to retry backoff (e.g. 0.2 = ±20%).
   * De-synchronizes concurrent runs retrying the same upstream outage.
   * Default 0.2 (see DEFAULT_WORKFLOW_CONFIG); 0 disables (deterministic).
   */
  retryJitter?: number;
  /**
   * E6/P0-6 dir-2: consecutive turns with zero files/commands output that trips
   * the no-progress pause. Default 3 (see DEFAULT_WORKFLOW_CONFIG). 0 disables.
   */
  noProgressTurns?: number;
  workspace: {
    // E9/ADR-008: `root` removed — autopilot delegates worktree management to the
    // host; root was never consumed at runtime. (state.workspace.root on
    // WorkspaceRecord is a DIFFERENT field — the checkpoint root — and stays.)
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
  | { type: 'agent_turn_started'; runId: string; now: number }
  | { type: 'agent_activity'; runId: string; activity: 'llm_output' | 'tool_call' | 'tool_result'; now: number; tokens?: { input?: number; output?: number; total?: number } }
  | { type: 'agent_turn_finished'; runId: string; success: boolean; error?: string; now: number }
  | { type: 'retry_due'; runId: string; now: number }
  | { type: 'stall_timeout'; runId: string; now: number }
  | { type: 'evidence_started'; runId: string; now: number }
  | { type: 'evidence_finished'; runId: string; evidence: EvidenceSummary; now: number }
  | { type: 'stop_requested'; runId: string; now: number }
  | { type: 'resume_requested'; runId: string; now: number }
  // W1 Phase 1.5: pause_requested routes the 4 pause() call sites through the
  // reducer so status is derived, not imperatively set. The reducer maps the
  // PauseReason to a BlockedReason via pauseReasonToBlockedReason (total, no
  // fallback) and sets orchState='blocked'. TENSION 3: this event is status-only
  // — if the reducer already moved off the running family (e.g. via
  // agent_turn_finished → retry_queued/blocked), pause_requested no-ops.
  | { type: 'pause_requested'; runId: string; reason: PauseReason; now: number }
  // E2/TENSION 3: hard cap (wall-clock/cost) termination. Unlike pause_requested
  // (which no-ops off the running family, incl. retry_queued — a recoverable
  // breaker must survive a pause), a hard cap MUST terminate even a retrying
  // run. Only truly terminal states (done, user-stopped) are exempt.
  | { type: 'hard_stop_requested'; runId: string; reason: PauseReason; now: number }
  // ADR-020: degraded cross-turn fallback (was a bare spread at index.ts:1058).
  // Folds totalContinuations++/needsCrossTurnResume/turnAttempts/degraded into the
  // reducer so it is the sole writer of those coupled aux fields.
  | { type: 'cross_turn_degraded'; runId: string; now: number }
  // ADR-020 step 2: clears needsCrossTurnResume when the resumed turn begins
  // finalizing (before_agent_finalize handshake, NOT agent_turn_started).
  | { type: 'cross_turn_resume_consumed'; runId: string; now: number }
  // ADR-020 step 4 (degraded lifecycle): the canary-failed / canary-fired flag
  // flips on `degraded` were bare spreads in index.ts (agent_end). Folding them
  // into the reducer makes it the sole writer of `degraded`. The two
  // needsCrossTurnResume bare spreads remain until E13 (P3-29) — they ARE the
  // cross-turn handshake / gateway-restart double-spend surface.
  | { type: 'degradation_marked'; runId: string; now: number }
  | { type: 'degradation_cleared'; runId: string; now: number };

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
  /** E2: per-run hard caps carried from config (persisted for crash recovery). */
  maxDurationMs?: number;
  maxCostUsd?: number;
  /** E5: structured progress ledger (bounded; persisted via checkpoint at the
   *  E1-unified root). Replaces the "Turn N/M" counter string. */
  ledger?: Ledger;
  /**
   * E6/P0-6 dir-1: timestamp a tool/validation was dispatched (in-flight). While
   * set, the stall patrol uses the longer per-tool cap (not stallTimeoutMs) so a
   * legitimately long tool doesn't false-stall. Cleared on after_tool_call /
   * agent_end / before_agent_finalize to avoid a dangling field permanently
   * disabling stall detection.
   */
  inFlightToolStartedAt?: number;
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
  /**
   * Enhancement C (ADR-019): per-run trust decision (payload ?? config ?? false),
   * stamped at activate time. Used by minTurnsBeforeComplete to raise the
   * early-completion threshold for verifiable trusted tasks. Persisted through
   * the checkpoint allowlist so crash-recovered runs retain their trust level.
   */
  trustWorkspace?: boolean;
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
  /**
   * E2/P0-5: hard wall-clock cap in ms. Enforced primarily by the 60s patrol
   * (before_agent_finalize doesn't fire on API errors). When exceeded the run
   * is hard-stopped (max_duration_reached). Undefined = no wall-clock cap.
   */
  maxDurationMs?: number;
  /**
   * E2/P0-5: hard cost cap in USD, computed from reported token usage. No-op
   * when the host omits usage (totalTokensUsed stays 0). Undefined = no cap.
   */
  maxCostUsd?: number;
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
    maxDurationMs: config.maxDurationMs,
    maxCostUsd: config.maxCostUsd,
    // Enhancement C (ADR-019): carry trustWorkspace onto state so
    // minTurnsBeforeComplete can condition the early-completion threshold.
    trustWorkspace: config.trustWorkspace ?? false,
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
