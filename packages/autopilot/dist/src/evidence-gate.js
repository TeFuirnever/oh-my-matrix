"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateEvidence = evaluateEvidence;
exports.summarizeDiff = summarizeDiff;
const MAX_DIFF_SUMMARY_LENGTH = 500;
/**
 * Evaluate evidence from validation command results.
 * Returns an EvidenceSummary with pass/fail/skipped status.
 */
function evaluateEvidence(input) {
    const { commands, results, diffSummary, now, failOnOptional = false } = input;
    // No validation commands configured → skipped
    if (commands.length === 0) {
        return {
            status: 'skipped',
            diffSummary: summarizeDiff(diffSummary),
            commands: [],
            completedAt: now,
            failureReason: 'no validation commands configured',
        };
    }
    // Build a map of results by id for lookup
    const resultsById = new Map();
    for (const r of results) {
        resultsById.set(r.id, r);
    }
    // Track which required commands failed
    const failedRequiredIds = [];
    const failedOptionalIds = [];
    for (const cmd of commands) {
        const result = resultsById.get(cmd.id);
        if (!result || result.status === 'skipped') {
            // Command was never run or was skipped
            if (cmd.required) {
                failedRequiredIds.push(cmd.id);
            }
            continue;
        }
        if (result.status === 'failed' || result.status === 'timeout') {
            if (cmd.required) {
                failedRequiredIds.push(cmd.id);
            }
            else {
                failedOptionalIds.push(cmd.id);
            }
        }
    }
    // Determine final status
    if (failedRequiredIds.length > 0) {
        return {
            status: 'failed',
            diffSummary: summarizeDiff(diffSummary),
            commands: results,
            completedAt: now,
            failureReason: `required command(s) failed: ${failedRequiredIds.join(', ')}`,
        };
    }
    if (failedOptionalIds.length > 0 && failOnOptional) {
        return {
            status: 'failed',
            diffSummary: summarizeDiff(diffSummary),
            commands: results,
            completedAt: now,
            failureReason: `optional command(s) failed: ${failedOptionalIds.join(', ')}`,
        };
    }
    // All required passed, optional failures are acceptable
    return {
        status: 'passed',
        diffSummary: summarizeDiff(diffSummary),
        commands: results,
        completedAt: now,
    };
}
/**
 * Truncate and clean up diff summary for display.
 */
function summarizeDiff(diff) {
    if (!diff)
        return '';
    if (diff.length > MAX_DIFF_SUMMARY_LENGTH) {
        return diff.substring(0, MAX_DIFF_SUMMARY_LENGTH - 3) + '...';
    }
    return diff;
}
//# sourceMappingURL=evidence-gate.js.map