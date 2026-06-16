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
export type RunOutcomeKind = "completed" | "failed" | "blocked" | "cancelled";
export interface RunOutcome {
    kind: RunOutcomeKind;
    mode: "team";
    reason?: string;
    finishedAt: string;
}
/**
 * Map a terminal phase string from a state record to a `RunOutcomeKind`,
 * or null if the phase is non-terminal. The phase strings differ slightly
 * from the outcome kinds (`complete` vs `completed`) — this helper bridges
 * them.
 */
export declare function phaseToOutcomeKind(phase: string): RunOutcomeKind | null;
/** Inverse of phaseToOutcomeKind — the phase string for a given outcome kind. */
export declare function outcomeKindToPhase(kind: RunOutcomeKind): string;
/**
 * Build a `RunOutcome`. `finishedAt` defaults to now (ISO8601). Throws when
 * given an invalid kind or mode so callers get fast feedback rather than
 * persisting nonsense.
 */
export declare function makeRunOutcome(input: {
    kind: RunOutcomeKind;
    mode: RunOutcome["mode"];
    reason?: string;
    finishedAt?: string;
}): RunOutcome;
/** True when `value` is a structurally-valid `RunOutcome`. */
export declare function isRunOutcome(value: unknown): value is RunOutcome;
/**
 * Extract a `RunOutcome` from a terminal state record, or null if the state
 * is still active. Reads `mode`, the `current_phase` field, and `completedAt`.
 */
export declare function deriveOutcomeFromState(state: Record<string, unknown>): RunOutcome | null;
