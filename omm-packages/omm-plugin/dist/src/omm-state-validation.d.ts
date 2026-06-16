/** State validation for the omm team workflow skill. */
export interface StateValidationResult {
    ok: boolean;
    state?: Record<string, unknown>;
    warning?: string;
    error?: string;
}
/** Validate and normalize state for a given key. Unknown keys pass through with timestamp only. */
export declare function validateStateWrite(key: string, value: Record<string, unknown>, options?: {
    nowIso?: string;
}): StateValidationResult;
