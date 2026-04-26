/**
 * Autopilot pipeline — typed helpers over the `plan: Stage[]` field on the
 * autopilot mode state. Each helper returns a state patch that the caller
 * applies via `updateModeState("autopilot", patch)`. The helpers stay pure
 * (no I/O); SKILL.md orchestration owns retry/skip/blocked policy.
 *
 * Field shape per docs/contracts/workflow-state-contract.md:
 *   plan: Stage[]   where Stage = { step, description, status, retries }
 */
const STAGE_STATUSES = new Set([
    "pending",
    "in_progress",
    "complete",
    "failed",
]);
function isStage(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const v = value;
    if (typeof v.step !== "number" || !Number.isInteger(v.step) || v.step < 0) {
        return false;
    }
    if (typeof v.description !== "string")
        return false;
    if (typeof v.status !== "string" ||
        !STAGE_STATUSES.has(v.status)) {
        return false;
    }
    if (typeof v.retries !== "number" ||
        !Number.isInteger(v.retries) ||
        v.retries < 0) {
        return false;
    }
    if (v.summary !== undefined && typeof v.summary !== "string")
        return false;
    return true;
}
/** Validate a plan array. Rejects malformed stages and duplicate `step` values. */
export function validatePlan(stages) {
    if (!Array.isArray(stages)) {
        return { ok: false, error: "plan must be an array" };
    }
    const seen = new Set();
    for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        if (!isStage(stage)) {
            return { ok: false, error: `plan[${i}] must be a valid Stage` };
        }
        if (seen.has(stage.step)) {
            return { ok: false, error: `duplicate stage step: ${stage.step}` };
        }
        seen.add(stage.step);
    }
    return { ok: true };
}
function getPlan(state) {
    const plan = state.plan;
    if (!Array.isArray(plan))
        return null;
    // Skip plans with malformed entries; caller-side semantics treat this as
    // "no usable plan" rather than throwing during a getCurrentStage call.
    for (const stage of plan) {
        if (!isStage(stage))
            return null;
    }
    return plan;
}
function getCurrentStep(state) {
    const v = state.current_step;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}
/**
 * Return the stage at `current_step` index, or null if no usable plan exists
 * or the index is out of bounds.
 */
export function getCurrentStage(state) {
    const plan = getPlan(state);
    if (!plan)
        return null;
    const idx = getCurrentStep(state);
    return idx < plan.length ? plan[idx] : null;
}
/**
 * Update one stage's status (and optional summary) without mutating the
 * input state. Caller persists via `updateModeState("autopilot", patch)`.
 */
export function markStageStatus(state, step, status, summary) {
    if (!STAGE_STATUSES.has(status)) {
        return { ok: false, error: `invalid status: ${status}` };
    }
    const plan = getPlan(state);
    if (!plan)
        return { ok: false, error: "plan is missing or malformed" };
    const idx = plan.findIndex((s) => s.step === step);
    if (idx === -1) {
        return { ok: false, error: `stage step not found: ${step}` };
    }
    const next = plan.slice();
    const updated = { ...plan[idx], status };
    if (summary !== undefined)
        updated.summary = summary;
    next[idx] = updated;
    return { ok: true, patch: { plan: next } };
}
/**
 * Increment a stage's retries counter by 1. Stays primitive — does not
 * compare against `max_retries_per_step`; SKILL.md owns that policy.
 */
export function incrementRetry(state, step) {
    const plan = getPlan(state);
    if (!plan)
        return { ok: false, error: "plan is missing or malformed" };
    const idx = plan.findIndex((s) => s.step === step);
    if (idx === -1) {
        return { ok: false, error: `stage step not found: ${step}` };
    }
    const next = plan.slice();
    next[idx] = { ...plan[idx], retries: plan[idx].retries + 1 };
    return { ok: true, patch: { plan: next } };
}
/**
 * Advance to the next stage. Strict: refuses unless the current stage's
 * status is `complete`. Returns a patch incrementing `current_step` and
 * setting the next stage (if any) to `in_progress`.
 */
export function advanceStage(state) {
    const plan = getPlan(state);
    if (!plan)
        return { ok: false, error: "plan is missing or malformed" };
    const idx = getCurrentStep(state);
    if (idx >= plan.length) {
        return { ok: false, error: "already past the last stage" };
    }
    const current = plan[idx];
    if (current.status !== "complete") {
        return {
            ok: false,
            error: `cannot advance: current stage step=${current.step} is ${current.status}, expected complete`,
        };
    }
    const nextIdx = idx + 1;
    const patch = { current_step: nextIdx };
    if (nextIdx < plan.length) {
        const updated = plan.slice();
        updated[nextIdx] = { ...plan[nextIdx], status: "in_progress" };
        patch.plan = updated;
    }
    return { ok: true, patch };
}
//# sourceMappingURL=omm-autopilot-pipeline.js.map