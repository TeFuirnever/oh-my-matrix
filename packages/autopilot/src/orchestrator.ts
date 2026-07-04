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
import { toBlockedReason, pauseReasonToBlockedReason } from './types';
import { classifyRecoverability, shouldRetry, buildRetryEntry } from './retry-queue';
import { DEFAULT_WORKFLOW_CONFIG } from './workflow-config';

/**
 * Recoverable blocked reasons that can be resumed.
 *
 * W1 Phase 1.5: re-derived from the pauseReasonToBlockedReason mapping. The 5
 * new terminal BlockedReasons (max_total_reached, tool_error_repeated,
 * loop_breaker_triggered, context_overflow_unrecoverable, injection_rejected)
 * are deliberately NON-resumable EXCEPT injection_rejected — a workflow
 * injection failure is transient (the host may accept it on retry), so it stays
 * resumable. This is a deliberate widening documented in ADR-016.
 */
export const RESUMABLE_BLOCKED_REASONS: ReadonlySet<BlockedReason> = new Set([
  'stalled',
  'validation_failed',
  'evidence_missing',
  'injection_rejected', // W1: deliberate widening (transient injection failure)
]);

/**
 * Derive the user-facing `status` field from `orchestrationState` + `blockedReason`.
 *
 * W1 (dual state machine collapse): `status` is moving toward being a derived
 * field with the reducer as its sole writer. This function encodes the mapping
 * so that, once all writers route through the reducer, `status` is always a
 * pure function of orchState — eliminating the H1-class bug where the two
 * fields could disagree.
 *
 * Mapping (evidence-based from current autopilot-state.ts setter behavior):
 *   done                              → 'done'
 *   blocked + user_stopped            → 'idle'     (terminal, user-initiated)
 *   blocked + resumable reason        → 'paused'   (recoverable)
 *   blocked + other non-resumable     → 'paused'   (parked, not resumable)
 *   unclaimed/claimed/running/released/retry_queued → 'running'
 *
 * NOTE: this is currently reference-only — no production writer uses it yet.
 * Phase 2 will route all writers through the reducer, which will call this.
 */
export function deriveStatus(state: Pick<AutopilotState, 'orchestrationState' | 'blockedReason'>): AutopilotState['status'] {
  const orch = state.orchestrationState;
  if (orch === undefined) return 'idle'; // pre-activate / no run
  if (orch === 'done') return 'done';
  if (orch === 'blocked') {
    if (state.blockedReason === 'user_stopped') return 'idle';
    return 'paused';
  }
  // unclaimed, claimed, running, released, retry_queued — all active states.
  return 'running';
}

/**
 * Apply an orchestrator event to the current state.
 * Returns a new state object (immutable).
 *
 * W1 Phase 3: the reducer is the sole writer of `status`. Every return path
 * flows through a post-switch derivation step that sets `status = deriveStatus(result)`,
 * guaranteeing status is always consistent with orchState+blockedReason.
 */
export function orchestratorReducer(
  state: AutopilotState,
  event: OrchestratorEvent,
): AutopilotState {
  const next = reducerCore(state, event);
  // Sole-writer invariant: status is always derived, never independently set.
  const derivedStatus = deriveStatus(next);
  return next.status === derivedStatus ? next : { ...next, status: derivedStatus };
}

function reducerCore(state: AutopilotState, event: OrchestratorEvent): AutopilotState {
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
    // M2 NOTE: this event + permission_denied below are defined in the reducer
    // but never dispatched from index.ts. Tool blocks are handled by the host's
    // before_tool_call veto, not via orchestrator events. Kept as reducer-level
    // API surface for future use (e.g. if workspace creation moves into the
    // orchestrator). Tests cover the reducer contract; the dispatch gap is intentional.
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
            // W1b: don't use toBlockedReason (falls back to validation_failed which
            // is RESUMABLE). Use the explicit non-resumable default for unrecognized
            // error strings, and only map known ones directly.
            : toBlockedReason(event.error ?? 'unknown error', 'unrecoverable_error'),
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
        needsCrossTurnResume: true,
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

    // ─── pause_requested → blocked (W1 Phase 1.5, TENSION 3) ────────────
    // Routes the 4 pause() call sites through the reducer so status derives
    // from orchState, not an imperative setter. The PauseReason maps to a
    // BlockedReason via pauseReasonToBlockedReason (total — no fallback that
    // could make terminal reasons look resumable, TENSION 1).
    //
    // TENSION 3 reconciliation: pause_requested is status-only. If the reducer
    // already moved off the running family (e.g. agent_turn_finished fired an
    // error → retry_queued/blocked), pause_requested NO-OPS — the reducer's own
    // retry/block decision wins. This prevents a double-transition where a
    // loop-breaker pause arrives after the turn already failed and retried.
    case 'pause_requested': {
      // TENSION 3: exclude 'retry_queued' — a recoverable breaker under retry cap
      // must survive a subsequent pause_requested (branch-A contract). Only
      // pause from the active-running family, not from an already-retrying state.
      const runningFamily: OrchestrationState[] = [
        'running', 'claimed', 'released', 'unclaimed',
      ];
      if (!runningFamily.includes(state.orchestrationState as OrchestrationState)) return state;
      return {
        ...state,
        orchestrationState: 'blocked' as const,
        blockedReason: pauseReasonToBlockedReason(event.reason),
        lastActivityAt: event.now,
      };
    }

    // ─── blocked/unclaimed + resume_requested → claimed (only recoverable)
    case 'resume_requested': {
      // REV-1 fix: also handle 'unclaimed' (a run paused before dispatch).
      // Without this, resume of an unclaimed run is a silent no-op: state stays
      // unclaimed, kickResumedTurn early-returns, but the caller sees success.
      if (state.orchestrationState !== 'blocked' && state.orchestrationState !== 'unclaimed') return state;
      // For blocked runs, only recoverable reasons can resume.
      if (state.orchestrationState === 'blocked') {
        const reason = state.blockedReason;
        if (!reason || !RESUMABLE_BLOCKED_REASONS.has(reason)) {
          return state;
        }
      }
      return {
        ...state,
        orchestrationState: 'claimed',
        blockedReason: undefined,
        needsCrossTurnResume: true,
        lastActivityAt: event.now,
      };
    }

    default: {
      // Unknown event type — no-op
      return state;
    }
  }
}

