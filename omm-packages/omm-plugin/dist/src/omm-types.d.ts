/**
 * Typed workflow state shape for the team mode.
 *
 * Internal plumbing (readState, writeState, validateStateWrite) stays
 * Record<string, unknown> because state is parsed from JSON. These types
 * give callers compile-time narrowing at the API boundary.
 *
 * Usage:
 *   import type { TeamState } from "./omm-types.js";
 *   const raw = await getModeState("team", { stateRoot });
 *   const team = raw as TeamState | null;
 *   if (team?.active) { ... team.fix_loop_count, team.current_phase ... }
 */
import type { RunOutcome } from "./omm-run-outcome.js";
export type TeamPhase = "planning" | "decomposing" | "executing" | "verifying" | "fixing" | "delegating" | "complete" | "blocked" | "failed";
export interface TeamState {
    [key: string]: unknown;
    mode: "team";
    active: boolean;
    current_phase?: TeamPhase;
    fix_loop_count?: number;
    max_fix_loops?: number;
    startedAt?: string;
    completedAt?: string;
    lastUpdatedAt?: string;
    outcome?: RunOutcome;
    task?: string;
}
export type WorkflowState = TeamState;
/**
 * Map a `WorkflowMode` literal to its corresponding state shape.
 *
 * Used by `omm-mode-lifecycle.ts` to give callers compile-time narrowing:
 *
 *   const team = await getModeState("team");  // typed as TeamState | null
 */
export type WorkflowStateOf<M extends "team"> = M extends "team" ? TeamState : never;
