/**
 * Autopilot pipeline — typed helpers over the `plan: Stage[]` field on the
 * autopilot mode state. Each helper returns a state patch that the caller
 * applies via `updateModeState("autopilot", patch)`. The helpers stay pure
 * (no I/O); SKILL.md orchestration owns retry/skip/blocked policy.
 *
 * Field shape per docs/contracts/workflow-state-contract.md:
 *   plan: Stage[]   where Stage = { step, description, status, retries }
 */
export type StageStatus = "pending" | "in_progress" | "complete" | "failed";
export interface Stage {
  step: number;
  description: string;
  status: StageStatus;
  retries: number;
  summary?: string;
}
export interface PlanValidation {
  ok: boolean;
  error?: string;
}
/** Validate a plan array. Rejects malformed stages and duplicate `step` values. */
export declare function validatePlan(stages: unknown): PlanValidation;
/**
 * Return the stage at `current_step` index, or null if no usable plan exists
 * or the index is out of bounds.
 */
export declare function getCurrentStage(
  state: Record<string, unknown>,
): Stage | null;
export interface PipelinePatch {
  ok: boolean;
  patch?: Record<string, unknown>;
  error?: string;
}
/**
 * Update one stage's status (and optional summary) without mutating the
 * input state. Caller persists via `updateModeState("autopilot", patch)`.
 */
export declare function markStageStatus(
  state: Record<string, unknown>,
  step: number,
  status: StageStatus,
  summary?: string,
): PipelinePatch;
/**
 * Increment a stage's retries counter by 1. Stays primitive — does not
 * compare against `max_retries_per_step`; SKILL.md owns that policy.
 */
export declare function incrementRetry(
  state: Record<string, unknown>,
  step: number,
): PipelinePatch;
/**
 * Advance to the next stage. Strict: refuses unless the current stage's
 * status is `complete`. Returns a patch incrementing `current_step` and
 * setting the next stage (if any) to `in_progress`.
 */
export declare function advanceStage(
  state: Record<string, unknown>,
): PipelinePatch;
