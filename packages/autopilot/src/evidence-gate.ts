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
  /** V1: commands configured but dropped at load (S1 allowlist) — a dropped
   *  required command means "configured but didn't run" (not_executed), NOT
   *  "never configured" (not_configured → done). */
  droppedCommands?: number;
}

const MAX_DIFF_SUMMARY_LENGTH = 500;

/**
 * Evaluate evidence from validation command results.
 * Returns an EvidenceSummary with pass/fail/skipped status.
 */
export function evaluateEvidence(input: EvaluateEvidenceInput): EvidenceSummary {
  const { commands, results, diffSummary, now, failOnOptional = false, droppedCommands = 0 } = input;

  // No validation commands configured → skipped (not_configured: legitimate → done).
  // BUT: commands dropped by the S1 allowlist at load are "configured but didn't
  // run" → not_executed (fail-closed: the run must NOT complete unverified).
  if (commands.length === 0) {
    if (droppedCommands > 0) {
      return {
        status: 'skipped',
        diffSummary: summarizeDiff(diffSummary),
        commands: [],
        completedAt: now,
        failureReason: `${droppedCommands} validation command(s) dropped by the binary allowlist`,
        skipReason: 'not_executed',
      };
    }
    return {
      status: 'skipped',
      diffSummary: summarizeDiff(diffSummary),
      commands: [],
      completedAt: now,
      failureReason: 'no validation commands configured',
      skipReason: 'not_configured',
    };
  }

  // Build a map of results by id for lookup
  const resultsById = new Map<string, EvidenceCommandResult>();
  for (const r of results) {
    resultsById.set(r.id, r);
  }

  // Track which required commands failed
  const failedRequiredIds: string[] = [];
  const failedOptionalIds: string[] = [];
  // V1: required commands that never produced a real verdict (missing result /
  // skipped / timeout) — "configured but didn't run" → evidence_missing
  // (resumable), NOT a hard failure (per design §3.1: 命令缺失/超时 → blocked).
  const notExecutedRequiredIds: string[] = [];

  for (const cmd of commands) {
    const result = resultsById.get(cmd.id);

    if (!result || result.status === 'skipped' || result.status === 'timeout') {
      // Command was never run, was skipped, or timed out — no verdict. A
      // timeout is not proof of failure; the operator may fix the command
      // (or its timeout) and resume. Only a real exit-code failure is failed.
      if (cmd.required) {
        notExecutedRequiredIds.push(cmd.id);
      }
      continue;
    }

    if (result.status === 'failed' || result.status === 'output_overflow') {
      if (cmd.required) {
        failedRequiredIds.push(cmd.id);
      } else {
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

  // V1: no real failures, but required commands never produced a verdict
  // (missing / skipped / timed out / dropped at load) → not_executed →
  // blocked evidence_missing (resumable). Real failures above win; this only
  // fires when nothing actually failed.
  if (notExecutedRequiredIds.length > 0) {
    return {
      status: 'skipped',
      diffSummary: summarizeDiff(diffSummary),
      commands: results,
      completedAt: now,
      failureReason: `required command(s) did not run: ${notExecutedRequiredIds.join(', ')}`,
      skipReason: 'not_executed',
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
export function summarizeDiff(diff: string): string {
  if (!diff) return '';
  if (diff.length > MAX_DIFF_SUMMARY_LENGTH) {
    return diff.substring(0, MAX_DIFF_SUMMARY_LENGTH - 3) + '...';
  }
  return diff;
}
