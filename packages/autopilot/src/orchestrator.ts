/**
 * M2.5 Orchestrator Reducer
 *
 * Pure function state machine for Autopilot orchestration.
 * Single-writer constraint: all state transitions go through this reducer.
 * No side effects — no file I/O, no IPC, no network.
 */
import type {
  AutopilotState,
  OrchestratorEvent,
  OrchestrationState,
  BlockedReason,
} from './types';
import { toBlockedReason } from './types';
import { classifyRecoverability, shouldRetry, buildRetryEntry } from './retry-queue';
import { DEFAULT_WORKFLOW_CONFIG } from './workflow-config';

/** Recoverable blocked reasons that can be resumed */
export const RESUMABLE_BLOCKED_REASONS: ReadonlySet<BlockedReason> = new Set([
  'stalled',
  'validation_failed',
  'evidence_missing',
]);

/**
 * Apply an orchestrator event to the current state.
 * Returns a new state object (immutable).
 */
export function orchestratorReducer(
  state: AutopilotState,
  event: OrchestratorEvent,
): AutopilotState {
  switch (event.type) {
    // ─── idle → unclaimed ─────────────────────────────────────
    case 'activate_requested': {
      return {
        ...state,
        orchestrationState: 'unclaimed',
        goal: event.goal ?? state.goal,
        startedAt: event.now,
        lastActivityAt: event.now,
        blockedReason: undefined,
        retry: undefined,
        evidence: undefined,
        workspace: undefined,
        status: 'running',
        enabled: true,
      };
    }

    // ─── unclaimed + workspace_ready → claimed ────────────────
    case 'workspace_ready': {
      if (state.orchestrationState !== 'unclaimed') return state;
      return {
        ...state,
        orchestrationState: 'claimed',
        workspace: event.workspace,
        blockedReason: undefined,
        retry: undefined,
        lastActivityAt: event.now,
      };
    }

    // ─── unclaimed + workspace_failed → blocked ───────────────
    case 'workspace_failed': {
      if (state.orchestrationState !== 'unclaimed') return state;
      return {
        ...state,
        orchestrationState: 'blocked',
        blockedReason: 'workspace_create_failed',
        lastActivityAt: event.now,
      };
    }

    // ─── claimed + agent_turn_started → running ───────────────
    case 'agent_turn_started': {
      if (state.orchestrationState !== 'claimed') return state;
      return {
        ...state,
        orchestrationState: 'running',
        lastActivityAt: event.now,
      };
    }

    // ─── agent_activity → update tokens/activity (runs regardless of orchestration state)
    case 'agent_activity': {
      const next: AutopilotState = {
        ...state,
        lastActivityAt: event.now,
      };
      if (event.tokens?.input) {
        next.inputTokensUsed = (state.inputTokensUsed ?? 0) + event.tokens.input;
      }
      if (event.tokens?.output) {
        next.outputTokensUsed = (state.outputTokensUsed ?? 0) + event.tokens.output;
      }
      return next;
    }

    // ─── running + agent_turn_finished ─────────────────────────
    case 'agent_turn_finished': {
      if (state.orchestrationState !== 'running') return state;

      if (event.success) {
        // Success → released (enter evidence gate)
        return {
          ...state,
          orchestrationState: 'released',
          lastActivityAt: event.now,
        };
      }

      // Error path
      const classification = classifyRecoverability(event.error ?? 'unknown error');
      const maxRetries = state.workflow?.maxRetries ?? 3;
      const maxRetryBackoffMs = state.workflow?.maxRetryBackoffMs ?? DEFAULT_WORKFLOW_CONFIG.maxRetryBackoffMs;
      const currentAttempt = (state.retry?.attempt ?? 0) + 1;

      if (!shouldRetry({ attempt: currentAttempt, maxRetries, recoverable: classification.recoverable })) {
        // Unrecoverable or max retries reached → blocked
        return {
          ...state,
          orchestrationState: 'blocked',
          blockedReason: classification.recoverable
            ? 'max_retries_reached'
            : toBlockedReason(event.error ?? 'unknown error'),
          lastActivityAt: event.now,
        };
      }

      // Recoverable → retry_queued
      const retryEntry = buildRetryEntry(currentAttempt, event.error ?? 'unknown', event.now, maxRetryBackoffMs);
      return {
        ...state,
        orchestrationState: 'retry_queued',
        retry: retryEntry,
        lastActivityAt: event.now,
      };
    }

    // ─── running + stall_timeout → retry_queued ────────────────
    case 'stall_timeout': {
      if (state.orchestrationState !== 'running') return state;
      const maxRetries = state.workflow?.maxRetries ?? 3;
      const maxRetryBackoffMs = state.workflow?.maxRetryBackoffMs ?? DEFAULT_WORKFLOW_CONFIG.maxRetryBackoffMs;
      const currentAttempt = (state.retry?.attempt ?? 0) + 1;

      if (!shouldRetry({ attempt: currentAttempt, maxRetries, recoverable: true })) {
        return {
          ...state,
          orchestrationState: 'blocked',
          blockedReason: 'max_retries_reached',
          lastActivityAt: event.now,
        };
      }

      const retryEntry = buildRetryEntry(currentAttempt, 'stalled', event.now, maxRetryBackoffMs);
      return {
        ...state,
        orchestrationState: 'retry_queued',
        retry: retryEntry,
        lastActivityAt: event.now,
      };
    }

    // ─── retry_queued + retry_due → claimed ────────────────────
    case 'retry_due': {
      if (state.orchestrationState !== 'retry_queued') return state;
      // No-op if not due yet
      if (state.retry && event.now < state.retry.nextRetryAt) {
        return state;
      }
      return {
        ...state,
        orchestrationState: 'claimed',
        lastActivityAt: event.now,
      };
    }

    // ─── released + evidence_started → released ────────────────
    case 'evidence_started': {
      if (state.orchestrationState !== 'released') return state;
      return {
        ...state,
        evidence: {
          ...(state.evidence ?? { commands: [] }),
          status: 'running',
        },
        lastActivityAt: event.now,
      };
    }

    // ─── released + evidence_finished ──────────────────────────
    case 'evidence_finished': {
      if (state.orchestrationState !== 'released') return state;

      if (event.evidence.status === 'passed' || event.evidence.status === 'skipped') {
        // Passed or skipped → done
        return {
          ...state,
          orchestrationState: 'done',
          status: 'done',
          enabled: false,
          evidence: event.evidence,
          lastActivityAt: event.now,
        };
      }

      // Failed → check retry
      const maxRetries = state.workflow?.maxRetries ?? 3;
      const maxRetryBackoffMs = state.workflow?.maxRetryBackoffMs ?? DEFAULT_WORKFLOW_CONFIG.maxRetryBackoffMs;
      const currentAttempt = (state.retry?.attempt ?? 0) + 1;

      if (shouldRetry({ attempt: currentAttempt, maxRetries, recoverable: true })) {
        const retryEntry = buildRetryEntry(currentAttempt, 'validation_failed', event.now, maxRetryBackoffMs);
        return {
          ...state,
          orchestrationState: 'retry_queued',
          retry: retryEntry,
          evidence: event.evidence,
          lastActivityAt: event.now,
        };
      }

      // Max retries reached → blocked
      return {
        ...state,
        orchestrationState: 'blocked',
        blockedReason: 'max_retries_reached',
        evidence: event.evidence,
        lastActivityAt: event.now,
      };
    }

    // ─── running + permission_denied → blocked ────────────────────────
    case 'permission_denied': {
      if (state.orchestrationState !== 'running') return state;
      return {
        ...state,
        orchestrationState: 'blocked',
        blockedReason: 'permission_denied',
        lastActivityAt: event.now,
      };
    }

    // ─── running/claimed/retry_queued/released/unclaimed + stop → blocked
    case 'stop_requested': {
      const stoppable: OrchestrationState[] = ['running', 'claimed', 'retry_queued', 'released', 'unclaimed'];
      if (!stoppable.includes(state.orchestrationState as OrchestrationState)) return state;
      return {
        ...state,
        orchestrationState: 'blocked',
        blockedReason: 'user_stopped',
        lastActivityAt: event.now,
      };
    }

    // ─── blocked + resume_requested → claimed (only recoverable)
    case 'resume_requested': {
      if (state.orchestrationState !== 'blocked') return state;
      const reason = state.blockedReason;
      if (!reason || !RESUMABLE_BLOCKED_REASONS.has(reason)) {
        return state;
      }
      return {
        ...state,
        orchestrationState: 'claimed',
        blockedReason: undefined,
        lastActivityAt: event.now,
      };
    }

    default: {
      // Unknown event type — no-op
      return state;
    }
  }
}
