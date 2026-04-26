/** State validation for omm workflow skills (ralph, autopilot, team). */
const RALPH_PHASES = [
    "init",
    "planning",
    "executing",
    "verifying",
    "fixing",
    "complete",
    "failed",
];
const AUTOPILOT_PHASES = [
    "analyzing",
    "planning",
    "executing",
    "verifying",
    "retry",
    "complete",
    "blocked",
    "failed",
];
const TEAM_PHASES = [
    "planning",
    "decomposing",
    "executing",
    "verifying",
    "fixing",
    "delegating",
    "complete",
    "failed",
];
const RALPH_PHASE_SET = new Set(RALPH_PHASES);
const AUTOPILOT_PHASE_SET = new Set(AUTOPILOT_PHASES);
const TEAM_PHASE_SET = new Set(TEAM_PHASES);
const TERMINAL_PHASES = new Set(["complete", "failed", "blocked"]);
function asNonNegInt(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    if (!Number.isInteger(value) || value < 0)
        return null;
    return value;
}
function asPosInt(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    if (!Number.isInteger(value) || value <= 0)
        return null;
    return value;
}
function isIsoTimestamp(value) {
    if (typeof value !== "string" || value.trim() === "")
        return false;
    return Number.isFinite(Date.parse(value));
}
function normalizePhase(raw, validSet, label) {
    if (typeof raw !== "string" || raw.trim() === "") {
        return { error: `${label} must be a non-empty string` };
    }
    const normalized = raw.trim().toLowerCase();
    if (!validSet.has(normalized)) {
        return { error: `${label} must be one of: ${[...validSet].join(", ")}` };
    }
    return { phase: normalized };
}
function validateTerminalRules(next, nowIso) {
    const phase = next.status;
    if (phase && TERMINAL_PHASES.has(phase)) {
        if (next.active === true) {
            return "terminal status requires active=false";
        }
        if (next.completedAt == null) {
            next.completedAt = nowIso;
        }
    }
    return undefined;
}
function validateTimestamps(next) {
    if (next.startedAt != null && !isIsoTimestamp(next.startedAt)) {
        return "startedAt must be an ISO8601 timestamp";
    }
    if (next.completedAt != null && !isIsoTimestamp(next.completedAt)) {
        return "completedAt must be an ISO8601 timestamp";
    }
    if (next.lastUpdatedAt != null && !isIsoTimestamp(next.lastUpdatedAt)) {
        return "lastUpdatedAt must be an ISO8601 timestamp";
    }
    return undefined;
}
function validateRalph(candidate, nowIso) {
    const next = { ...candidate };
    if (next.status != null) {
        const r = normalizePhase(next.status, RALPH_PHASE_SET, "ralph.status");
        if (r.error)
            return { ok: false, error: r.error };
        next.status = r.phase;
    }
    if (next.active === true) {
        if (next.iteration == null)
            next.iteration = 0;
        if (next.max_iterations == null)
            next.max_iterations = 10;
        if (next.fix_attempt == null)
            next.fix_attempt = 0;
        if (next.max_fix_attempts == null)
            next.max_fix_attempts = 3;
        if (next.status == null)
            next.status = "init";
        if (next.startedAt == null)
            next.startedAt = nowIso;
    }
    if (next.iteration != null && asNonNegInt(next.iteration) === null) {
        return {
            ok: false,
            error: "ralph.iteration must be a non-negative integer",
        };
    }
    if (next.max_iterations != null && asPosInt(next.max_iterations) === null) {
        return {
            ok: false,
            error: "ralph.max_iterations must be a positive integer",
        };
    }
    if (next.fix_attempt != null && asNonNegInt(next.fix_attempt) === null) {
        return {
            ok: false,
            error: "ralph.fix_attempt must be a non-negative integer",
        };
    }
    if (next.max_fix_attempts != null &&
        asPosInt(next.max_fix_attempts) === null) {
        return {
            ok: false,
            error: "ralph.max_fix_attempts must be a positive integer",
        };
    }
    const termErr = validateTerminalRules(next, nowIso);
    if (termErr)
        return { ok: false, error: termErr };
    const tsErr = validateTimestamps(next);
    if (tsErr)
        return { ok: false, error: tsErr };
    next.lastUpdatedAt = nowIso;
    return { ok: true, state: next };
}
function validateAutopilot(candidate, nowIso) {
    const next = { ...candidate };
    if (next.status != null) {
        const r = normalizePhase(next.status, AUTOPILOT_PHASE_SET, "autopilot.status");
        if (r.error)
            return { ok: false, error: r.error };
        next.status = r.phase;
    }
    if (next.active === true) {
        if (next.current_step == null)
            next.current_step = 0;
        if (next.total_steps == null)
            next.total_steps = 0;
        if (next.max_retries_per_step == null)
            next.max_retries_per_step = 3;
        if (next.status == null)
            next.status = "analyzing";
        if (next.startedAt == null)
            next.startedAt = nowIso;
    }
    if (next.current_step != null && asNonNegInt(next.current_step) === null) {
        return {
            ok: false,
            error: "autopilot.current_step must be a non-negative integer",
        };
    }
    if (next.total_steps != null && asNonNegInt(next.total_steps) === null) {
        return {
            ok: false,
            error: "autopilot.total_steps must be a non-negative integer",
        };
    }
    if (next.max_retries_per_step != null &&
        asPosInt(next.max_retries_per_step) === null) {
        return {
            ok: false,
            error: "autopilot.max_retries_per_step must be a positive integer",
        };
    }
    const termErr = validateTerminalRules(next, nowIso);
    if (termErr)
        return { ok: false, error: termErr };
    const tsErr = validateTimestamps(next);
    if (tsErr)
        return { ok: false, error: tsErr };
    next.lastUpdatedAt = nowIso;
    return { ok: true, state: next };
}
function validateTeam(candidate, nowIso) {
    const next = { ...candidate };
    if (next.current_phase != null) {
        const r = normalizePhase(next.current_phase, TEAM_PHASE_SET, "team.current_phase");
        if (r.error)
            return { ok: false, error: r.error };
        next.current_phase = r.phase;
    }
    if (next.active === true) {
        if (next.fix_loop_count == null)
            next.fix_loop_count = 0;
        if (next.max_fix_loops == null)
            next.max_fix_loops = 3;
        if (next.current_phase == null)
            next.current_phase = "planning";
        if (next.startedAt == null)
            next.startedAt = nowIso;
    }
    if (next.fix_loop_count != null &&
        asNonNegInt(next.fix_loop_count) === null) {
        return {
            ok: false,
            error: "team.fix_loop_count must be a non-negative integer",
        };
    }
    if (next.max_fix_loops != null && asPosInt(next.max_fix_loops) === null) {
        return {
            ok: false,
            error: "team.max_fix_loops must be a positive integer",
        };
    }
    // Team uses current_phase for terminal check instead of status
    const phase = next.current_phase;
    if (phase && TERMINAL_PHASES.has(phase)) {
        if (next.active === true) {
            return { ok: false, error: "terminal phase requires active=false" };
        }
        if (next.completedAt == null) {
            next.completedAt = nowIso;
        }
    }
    const tsErr = validateTimestamps(next);
    if (tsErr)
        return { ok: false, error: tsErr };
    next.lastUpdatedAt = nowIso;
    return { ok: true, state: next };
}
const VALIDATORS = {
    ralph: validateRalph,
    autopilot: validateAutopilot,
    team: validateTeam,
};
/** Validate and normalize state for a given key. Unknown keys pass through with timestamp only. */
export function validateStateWrite(key, value, options) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, error: "value must be a JSON object" };
    }
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const mode = value.mode ?? key;
    const validator = VALIDATORS[mode];
    if (validator) {
        return validator(value, nowIso);
    }
    // Unknown keys: pass through with timestamp
    const next = { ...value, lastUpdatedAt: nowIso };
    return { ok: true, state: next };
}
//# sourceMappingURL=omm-state-validation.js.map