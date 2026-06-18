import type { AutopilotState, PauseReason } from './types';

const MAX_GOAL_LENGTH = 500;

export function activate(state: AutopilotState): AutopilotState {
  if (state.status !== 'idle' && state.status !== 'done') {
    throw new Error(`Cannot activate from status "${state.status}", must be "idle" or "done"`);
  }
  return { ...state, status: 'running', enabled: true };
}

export function deactivate(state: AutopilotState): AutopilotState {
  if (state.status !== 'running' && state.status !== 'paused' && state.status !== 'done') {
    throw new Error(`Cannot deactivate from status "${state.status}"`);
  }
  return {
    ...state,
    status: 'idle',
    enabled: false,
    pauseReason: undefined,
    needsCrossTurnResume: false,
    degraded: false,
  };
}

export function pause(state: AutopilotState, reason: PauseReason): AutopilotState {
  if (state.status !== 'running') {
    throw new Error(`Cannot pause from status "${state.status}", must be "running"`);
  }
  return { ...state, status: 'paused', enabled: false, pauseReason: reason, needsCrossTurnResume: false };
}

export function complete(state: AutopilotState): AutopilotState {
  if (state.status !== 'running') {
    throw new Error(`Cannot complete from status "${state.status}", must be "running"`);
  }
  return { ...state, status: 'done', enabled: false, needsCrossTurnResume: false, degraded: false };
}

export function resume(state: AutopilotState): AutopilotState {
  if (state.status !== 'paused') {
    throw new Error(`Cannot resume from status "${state.status}", must be "paused"`);
  }
  return {
    ...state,
    status: 'running',
    enabled: true,
    pauseReason: undefined,
    toolErrorCount: 0,
    lastToolError: undefined,
    needsCrossTurnResume: false,
    degraded: false,
  };
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
