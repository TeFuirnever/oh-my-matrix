/**
 * Runtime completion contract — typed terminal outcomes for a workflow run.
 *
 * The team workflow mode ends in exactly one of:
 *   completed | failed | blocked | cancelled
 *
 * `RunOutcome` captures the kind, an optional reason, the mode, and the
 * timestamp the outcome was produced. Consumers can persist it on the state
 * record under the `outcome` field to make completion machine-readable
 * across sessions instead of inferring from `current_phase`.
 */
const VALID_KINDS = new Set([
    "completed",
    "failed",
    "blocked",
    "cancelled",
]);
const VALID_MODES = new Set(["team"]);
const KIND_TO_PHASE = {
    completed: "complete",
    failed: "failed",
    blocked: "blocked",
    cancelled: "cancelled",
};
const PHASE_TO_KIND = Object.fromEntries(Object.entries(KIND_TO_PHASE).map(([kind, phase]) => [
    phase,
    kind,
]));
/**
 * Map a terminal phase string from a state record to a `RunOutcomeKind`,
 * or null if the phase is non-terminal. The phase strings differ slightly
 * from the outcome kinds (`complete` vs `completed`) — this helper bridges
 * them.
 */
export function phaseToOutcomeKind(phase) {
    return PHASE_TO_KIND[phase.trim().toLowerCase()] ?? null;
}
/** Inverse of phaseToOutcomeKind — the phase string for a given outcome kind. */
export function outcomeKindToPhase(kind) {
    return KIND_TO_PHASE[kind];
}
/**
 * Build a `RunOutcome`. `finishedAt` defaults to now (ISO8601). Throws when
 * given an invalid kind or mode so callers get fast feedback rather than
 * persisting nonsense.
 */
export function makeRunOutcome(input) {
    if (!VALID_KINDS.has(input.kind)) {
        throw new Error(`invalid RunOutcome kind: ${input.kind}`);
    }
    if (!VALID_MODES.has(input.mode)) {
        throw new Error(`invalid RunOutcome mode: ${input.mode}`);
    }
    if (input.reason != null && typeof input.reason !== "string") {
        throw new Error("RunOutcome reason must be a string when present");
    }
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(finishedAt))) {
        throw new Error("RunOutcome finishedAt must be a valid ISO8601 timestamp");
    }
    return input.reason !== undefined
        ? { kind: input.kind, mode: input.mode, reason: input.reason, finishedAt }
        : { kind: input.kind, mode: input.mode, finishedAt };
}
/** True when `value` is a structurally-valid `RunOutcome`. */
export function isRunOutcome(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const v = value;
    if (typeof v.kind !== "string" || !VALID_KINDS.has(v.kind))
        return false;
    if (typeof v.mode !== "string" ||
        !VALID_MODES.has(v.mode))
        return false;
    if (typeof v.finishedAt !== "string")
        return false;
    if (!Number.isFinite(Date.parse(v.finishedAt)))
        return false;
    if (v.reason !== undefined && typeof v.reason !== "string")
        return false;
    return true;
}
/**
 * Extract a `RunOutcome` from a terminal state record, or null if the state
 * is still active. Reads `mode`, the `current_phase` field, and `completedAt`.
 */
export function deriveOutcomeFromState(state) {
    const mode = state.mode;
    if (typeof mode !== "string" ||
        !VALID_MODES.has(mode)) {
        return null;
    }
    const phaseField = "current_phase";
    const phase = state[phaseField];
    if (typeof phase !== "string")
        return null;
    const kind = phaseToOutcomeKind(phase);
    if (!kind)
        return null;
    if (state.active === true)
        return null;
    const finishedAt = typeof state.completedAt === "string"
        ? state.completedAt
        : new Date().toISOString();
    return makeRunOutcome({
        kind,
        mode: mode,
        finishedAt,
    });
}
//# sourceMappingURL=omm-run-outcome.js.map