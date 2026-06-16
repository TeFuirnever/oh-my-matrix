import { type RunOutcomeKind } from "./omm-run-outcome.js";
import type { WorkflowStateOf } from "./omm-types.js";
export type WorkflowMode = "team";
export interface ModeLifecycleConfig {
    stateRoot?: string;
}
export interface ModeOperationResult<M extends WorkflowMode = WorkflowMode> {
    ok: boolean;
    state?: WorkflowStateOf<M>;
    error?: string;
}
/**
 * Start a workflow mode. Writes a fresh active=true record after the
 * exclusivity guard passes. Default counters and status are injected by
 * the existing validator.
 */
export declare function startMode<M extends WorkflowMode>(mode: M, initialFields?: Record<string, unknown>, config?: ModeLifecycleConfig): Promise<ModeOperationResult<M>>;
/**
 * Update an active mode's state. Merges `patch` onto the existing record
 * and re-validates. Refuses when the mode is not currently active to
 * prevent accidental writes that would resurrect a terminated run; callers
 * who need that behavior should use `startMode` instead.
 */
export declare function updateModeState<M extends WorkflowMode>(mode: M, patch: Record<string, unknown>, config?: ModeLifecycleConfig): Promise<ModeOperationResult<M>>;
/**
 * Terminate a mode with the given outcome kind. Writes `active=false`,
 * the corresponding terminal phase, and stamps a `RunOutcome` record on
 * the `outcome` field. Idempotent: terminating an already-terminal record
 * is a no-op that returns the existing state.
 */
export declare function cancelMode<M extends WorkflowMode>(mode: M, reason: string | undefined, config?: ModeLifecycleConfig & {
    kind?: RunOutcomeKind;
}): Promise<ModeOperationResult<M>>;
/**
 * Read the current state of a mode. Returns null if no state file exists,
 * the parsed record otherwise. Return type is narrowed to the specific
 * state shape via `WorkflowStateOf<M>`.
 */
export declare function getModeState<M extends WorkflowMode>(mode: M, config?: ModeLifecycleConfig): Promise<WorkflowStateOf<M> | null>;
