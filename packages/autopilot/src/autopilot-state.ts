import type { AutopilotState, PauseReason } from './types';
import { deriveStatus } from './orchestrator';

const MAX_GOAL_LENGTH = 500;

/**
 * W1 Phase 2: the setters now derive `status` via `deriveStatus` instead of
 * hardcoding it. This makes status always a pure function of orchState +
 * blockedReason, even while the setters are still the ones clearing coupled
 * fields (pauseReason, needsCrossTurnResume, etc).
 *
 * The throw-guards on `state.status` remain as transition safety: they catch
 * callers that haven't routed through the reducer yet. Phase 3 will remove them
 * once all call sites dispatch reducer events and the reducer is the sole writer.
 *
 * NOTE: setters that don't change orchState (pause at a 'running' orchState,
 * complete at a 'running'/'released' orchState) still produce the correct
 * derived status because deriveStatus maps 'running'→'running' and only 'done'/
 * 'blocked' orchStates produce non-running statuses. The call sites are
 * responsible for ensuring orchState is correct BEFORE calling the setter —
 * which they already are (reducer runs first at every site).
 */
export function activate(state: AutopilotState): AutopilotState {
  if (state.status !== 'idle' && state.status !== 'done') {
    throw new Error(`Cannot activate from status "${state.status}", must be "idle" or "done"`);
  }
  const next = { ...state, orchestrationState: 'unclaimed' as const, blockedReason: undefined, enabled: true };
  return { ...next, status: deriveStatus(next) };
}

export function deactivate(state: AutopilotState): AutopilotState {
  // W1 Phase 3: allow 'idle' too — the reducer may have already derived it via
  // stop_requested → blocked → user_stopped → deriveStatus → 'idle'. The setter
  // is now idempotent for field-clearing when the reducer already did the transition.
  if (state.status !== 'running' && state.status !== 'paused' && state.status !== 'done' && state.status !== 'idle') {
    throw new Error(`Cannot deactivate from status "${state.status}"`);
  }
  const next: AutopilotState = {
    ...state,
    orchestrationState: 'blocked',
    blockedReason: 'user_stopped',
    enabled: false,
    pauseReason: undefined,
    needsCrossTurnResume: false,
    degraded: false,
  };
  return { ...next, status: deriveStatus(next) };
}

export function pause(state: AutopilotState, reason: PauseReason): AutopilotState {
  if (state.status !== 'running') {
    throw new Error(`Cannot pause from status "${state.status}", must be "running"`);
  }
  // W1 Phase 2: set orchState='blocked' + map the reason so deriveStatus works.
  // This is the transition step — Phase 3 will make this a pure reducer dispatch.
  const next: AutopilotState = {
    ...state,
    orchestrationState: 'blocked',
    blockedReason: pauseReasonToBlockedReasonSafe(reason),
    enabled: false,
    pauseReason: reason,
    needsCrossTurnResume: false,
  };
  return { ...next, status: deriveStatus(next) };
}

export function complete(state: AutopilotState): AutopilotState {
  if (state.status !== 'running') {
    throw new Error(`Cannot complete from status "${state.status}", must be "running"`);
  }
  const next: AutopilotState = {
    ...state,
    orchestrationState: 'done',
    enabled: false,
    needsCrossTurnResume: false,
    degraded: false,
  };
  return { ...next, status: deriveStatus(next) };
}

export function resume(state: AutopilotState): AutopilotState {
  if (state.status !== 'paused') {
    throw new Error(`Cannot resume from status "${state.status}", must be "paused"`);
  }
  const next: AutopilotState = {
    ...state,
    orchestrationState: 'claimed',
    blockedReason: undefined,
    enabled: true,
    pauseReason: undefined,
    toolErrorCount: 0,
    lastToolError: undefined,
    needsCrossTurnResume: false,
    degraded: false,
  };
  return { ...next, status: deriveStatus(next) };
}

// Local import to avoid circular dependency at module load — pauseReasonToBlockedReason
// is total but we guard anyway for defensive use inside the setter.
import { pauseReasonToBlockedReason } from './types';
function pauseReasonToBlockedReasonSafe(reason: PauseReason) {
  return pauseReasonToBlockedReason(reason);
}

export function incrementTurn(state: AutopilotState): AutopilotState {
  return { ...state, turnAttempts: state.turnAttempts + 1 };
}

export function incrementTotal(state: AutopilotState): AutopilotState {
  return { ...state, totalContinuations: state.totalContinuations + 1 };
}

export function resetTurnAttempts(state: AutopilotState): AutopilotState {
  return { ...state, turnAttempts: 0 };
}

export function setGoal(state: AutopilotState, goal: string): AutopilotState {
  return { ...state, goal: goal.substring(0, MAX_GOAL_LENGTH) };
}

export function snapshotGoal(state: AutopilotState): AutopilotState {
  return {
    ...state,
    goalSnapshot: state.goal,
    progressSnapshot: state.progress,
  };
}

export function restoreGoalFromSnapshot(state: AutopilotState): AutopilotState {
  return {
    ...state,
    goal: state.goal ?? state.goalSnapshot,
    progress: state.progressSnapshot ?? state.progress,
    goalSnapshot: undefined,
    progressSnapshot: undefined,
  };
}

/**
 * Detect whether a `running` session is STUCK — the autonomous loop has stalled
 * and will not recover on its own, so re-activation should discard it and start
 * a fresh run instead of hard-rejecting.
 *
 * A run is stuck when EITHER:
 *   - the orchestrator queued a retry that never completed (`retry_queued` — set
 *     by the stall handler), OR
 *   - there has been no activity for longer than the stall threshold.
 *
 * Why this exists: the stall handler sets `orchestrationState='retry_queued'` but
 * leaves `status='running'` (the stall interval only dispatches `stall_timeout`,
 * it does not pause). If the agent is genuinely dead the run sits in
 * `running`/`retry_queued` forever, and the activate handler's "must be idle or
 * done" guard blocks every subsequent activation — requiring a gateway restart.
 * Genuinely-active runs (recent activity, orchState='running') are NOT stuck and
 * stay protected from mid-flight reset.
 *
 * Scoped to `running` only: `paused` is an intentional, user-resumable state.
 * `now` and `stallTimeoutMs` are injectable for deterministic unit testing.
 */
export function isRunStuck(
  state: AutopilotState,
  now: number = Date.now(),
  stallTimeoutMs: number = 600_000,
): boolean {
  if (state.status !== 'running') return false;
  if (state.orchestrationState === 'retry_queued') return true;
  const lastActivity = state.lastActivityAt ?? state.startedAt ?? 0;
  if (lastActivity > 0 && now - lastActivity > stallTimeoutMs) return true;
  return false;
}
