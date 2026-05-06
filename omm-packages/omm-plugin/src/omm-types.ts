/**
 * Typed workflow state shapes — discriminated union over mode.
 *
 * Internal plumbing (readState, writeState, validateStateWrite) stays
 * Record<string, unknown> because state is parsed from JSON. These types
 * give callers compile-time narrowing at the API boundary.
 *
 * Usage:
 *   import type { RalphState } from "./omm-types.js";
 *   const raw = await getModeState("ralph", { stateRoot });
 *   const ralph = raw as RalphState | null;
 *   if (ralph?.active) { ... ralph.iteration, ralph.status ... }
 */
import type { RunOutcome } from "./omm-run-outcome.js";

// ── Phase literal types (source of truth: omm-state-validation.ts) ──

export type RalphPhase =
  | "init"
  | "planning"
  | "executing"
  | "verifying"
  | "fixing"
  | "complete"
  | "failed";

export type AutopilotPhase =
  | "analyzing"
  | "planning"
  | "executing"
  | "verifying"
  | "retry"
  | "complete"
  | "blocked"
  | "failed";

export type TeamPhase =
  | "planning"
  | "decomposing"
  | "executing"
  | "verifying"
  | "fixing"
  | "delegating"
  | "complete"
  | "failed";

// ── State shapes ──
// Index signature keeps these assignable to Record<string, unknown>.

export interface RalphState {
  [key: string]: unknown;
  mode: "ralph";
  active: boolean;
  status?: RalphPhase;
  iteration?: number;
  max_iterations?: number;
  fix_attempt?: number;
  max_fix_attempts?: number;
  startedAt?: string;
  completedAt?: string;
  lastUpdatedAt?: string;
  outcome?: RunOutcome;
  task?: string;
}

export interface AutopilotState {
  [key: string]: unknown;
  mode: "autopilot";
  active: boolean;
  status?: AutopilotPhase;
  current_step?: number;
  total_steps?: number;
  max_retries_per_step?: number;
  startedAt?: string;
  completedAt?: string;
  lastUpdatedAt?: string;
  outcome?: RunOutcome;
  task?: string;
}

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

export type WorkflowState = RalphState | AutopilotState | TeamState;
