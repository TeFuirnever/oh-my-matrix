export declare const WORKFLOW_MODES: Set<string>;
export interface ExclusivityCheckResult {
    ok: boolean;
    error?: string;
    conflictingMode?: string;
}
/**
 * Reject `active=true` workflow writes when another workflow mode is already
 * active. Same-key overwrites are allowed.
 */
export declare function assertWorkflowExclusivity(stateDir: string, incomingKey: string, incomingValue: Record<string, unknown>): Promise<ExclusivityCheckResult>;
