/**
 * M2.5 Orchestrator Reducer
 *
 * Pure function state machine for Autopilot orchestration.
 * Single-writer constraint: all state transitions go through this reducer.
 * No side effects — no file I/O, no IPC, no network.
 */
import type { AutopilotState, OrchestratorEvent, BlockedReason } from './types';
/** Recoverable blocked reasons that can be resumed */
export declare const RESUMABLE_BLOCKED_REASONS: ReadonlySet<BlockedReason>;
/**
 * Apply an orchestrator event to the current state.
 * Returns a new state object (immutable).
 */
export declare function orchestratorReducer(state: AutopilotState, event: OrchestratorEvent): AutopilotState;
//# sourceMappingURL=orchestrator.d.ts.map