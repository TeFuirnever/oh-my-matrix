import type { AutopilotState, PauseReason } from './types';
export declare function activate(state: AutopilotState): AutopilotState;
export declare function deactivate(state: AutopilotState): AutopilotState;
export declare function pause(state: AutopilotState, reason: PauseReason): AutopilotState;
export declare function complete(state: AutopilotState): AutopilotState;
export declare function resume(state: AutopilotState): AutopilotState;
export declare function incrementTurn(state: AutopilotState): AutopilotState;
export declare function incrementTotal(state: AutopilotState): AutopilotState;
export declare function resetTurnAttempts(state: AutopilotState): AutopilotState;
export declare function setGoal(state: AutopilotState, goal: string): AutopilotState;
export declare function snapshotGoal(state: AutopilotState): AutopilotState;
export declare function restoreGoalFromSnapshot(state: AutopilotState): AutopilotState;
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
export declare function isRunStuck(state: AutopilotState, now?: number, stallTimeoutMs?: number): boolean;
//# sourceMappingURL=autopilot-state.d.ts.map