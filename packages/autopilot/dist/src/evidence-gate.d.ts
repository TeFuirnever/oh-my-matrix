/**
 * M2.6 Evidence Gate
 *
 * Evaluates validation command results before marking a run as done.
 * Pure functions — no command execution, no I/O.
 */
import type { ValidationCommand, EvidenceCommandResult, EvidenceSummary } from './types';
export interface EvaluateEvidenceInput {
    commands: ValidationCommand[];
    results: EvidenceCommandResult[];
    diffSummary: string;
    now: number;
    failOnOptional?: boolean;
}
/**
 * Evaluate evidence from validation command results.
 * Returns an EvidenceSummary with pass/fail/skipped status.
 */
export declare function evaluateEvidence(input: EvaluateEvidenceInput): EvidenceSummary;
/**
 * Truncate and clean up diff summary for display.
 */
export declare function summarizeDiff(diff: string): string;
//# sourceMappingURL=evidence-gate.d.ts.map