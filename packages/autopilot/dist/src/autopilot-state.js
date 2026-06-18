"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
exports.pause = pause;
exports.complete = complete;
exports.resume = resume;
exports.incrementTurn = incrementTurn;
exports.incrementTotal = incrementTotal;
exports.resetTurnAttempts = resetTurnAttempts;
exports.setGoal = setGoal;
exports.snapshotGoal = snapshotGoal;
exports.restoreGoalFromSnapshot = restoreGoalFromSnapshot;
exports.isRunStuck = isRunStuck;
const MAX_GOAL_LENGTH = 500;
function activate(state) {
    if (state.status !== 'idle' && state.status !== 'done') {
        throw new Error(`Cannot activate from status "${state.status}", must be "idle" or "done"`);
    }
    return { ...state, status: 'running', enabled: true };
}
function deactivate(state) {
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
function pause(state, reason) {
    if (state.status !== 'running') {
        throw new Error(`Cannot pause from status "${state.status}", must be "running"`);
    }
    return { ...state, status: 'paused', enabled: false, pauseReason: reason, needsCrossTurnResume: false };
}
function complete(state) {
    if (state.status !== 'running') {
        throw new Error(`Cannot complete from status "${state.status}", must be "running"`);
    }
    return { ...state, status: 'done', enabled: false, needsCrossTurnResume: false, degraded: false };
}
function resume(state) {
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
function incrementTurn(state) {
    return { ...state, turnAttempts: state.turnAttempts + 1 };
}
function incrementTotal(state) {
    return { ...state, totalContinuations: state.totalContinuations + 1 };
}
function resetTurnAttempts(state) {
    return { ...state, turnAttempts: 0 };
}
function setGoal(state, goal) {
    return { ...state, goal: goal.substring(0, MAX_GOAL_LENGTH) };
}
function snapshotGoal(state) {
    return {
        ...state,
        goalSnapshot: state.goal,
        progressSnapshot: state.progress,
    };
}
function restoreGoalFromSnapshot(state) {
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
function isRunStuck(state, now = Date.now(), stallTimeoutMs = 600_000) {
    if (state.status !== 'running')
        return false;
    if (state.orchestrationState === 'retry_queued')
        return true;
    const lastActivity = state.lastActivityAt ?? state.startedAt ?? 0;
    if (lastActivity > 0 && now - lastActivity > stallTimeoutMs)
        return true;
    return false;
}
//# sourceMappingURL=autopilot-state.js.map