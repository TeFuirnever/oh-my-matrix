import { type RunOutcomeKind } from "./omm-run-outcome.js";
export type WorkflowMode = "ralph" | "autopilot" | "team";
export interface ModeLifecycleConfig {
  stateRoot?: string;
}
export interface ModeOperationResult {
  ok: boolean;
  state?: Record<string, unknown>;
  error?: string;
}
/**
 * Start a workflow mode. Writes a fresh active=true record after the
 * exclusivity guard passes. Default counters and status are injected by
 * the existing validator.
 */
export declare function startMode(
  mode: WorkflowMode,
  initialFields?: Record<string, unknown>,
  config?: ModeLifecycleConfig,
): Promise<ModeOperationResult>;
/**
 * Update an active mode's state. Merges `patch` onto the existing record
 * and re-validates. Refuses when the mode is not currently active to
 * prevent accidental writes that would resurrect a terminated run; callers
 * who need that behavior should use `startMode` instead.
 */
export declare function updateModeState(
  mode: WorkflowMode,
  patch: Record<string, unknown>,
  config?: ModeLifecycleConfig,
): Promise<ModeOperationResult>;
/**
 * Terminate a mode with the given outcome kind. Writes `active=false`,
 * the corresponding terminal phase, and stamps a `RunOutcome` record on
 * the `outcome` field. Idempotent: terminating an already-terminal record
 * is a no-op that returns the existing state.
 */
export declare function cancelMode(
  mode: WorkflowMode,
  reason: string | undefined,
  config?: ModeLifecycleConfig & {
    kind?: RunOutcomeKind;
  },
): Promise<ModeOperationResult>;
/**
 * Read the current state of a mode. Returns null if no state file exists,
 * the parsed record otherwise.
 */
export declare function getModeState(
  mode: WorkflowMode,
  config?: ModeLifecycleConfig,
): Promise<Record<string, unknown> | null>;
