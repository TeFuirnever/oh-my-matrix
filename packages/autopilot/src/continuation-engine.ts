import type { AutopilotState, ContinuationDecision } from './types';
import { isTaskComplete, hasNoActionableTask } from './completion-detector';
import { isThresholdExceeded } from './tool-error-tracker';

interface FinalizeEvent {
  lastAssistantMessage?: string;
  stopHookActive?: boolean;
}

/**
 * P1-2: Minimum number of cross-turn continuations that must elapse before a
 * textual completion signal (isTaskComplete) is trusted as 'complete'.
 *
 * Opening/mid-run summary phrasing ("所有任务已完成" / "all tasks completed") can
 * fire on the very first turn and historically terminated long runs early.
 * Requiring this many continuations forces the model to keep producing work
 * (and evidence) before it is allowed to stop. Raise for stricter safety,
 * lower for snappier simple-task handling.
 */
const MIN_TURNS_BEFORE_COMPLETE = 2;

export function decideContinuation(
  state: AutopilotState,
  event: FinalizeEvent,
): ContinuationDecision {
  if (!state.enabled || state.status !== 'running') {
    return { action: 'finalize' };
  }

  if (event.stopHookActive) {
    return { action: 'finalize' };
  }

  if (isTaskComplete(event.lastAssistantMessage, event.stopHookActive)) {
    // P1-2: don't trust an early completion signal. If too few continuations
    // have elapsed, demote to revise so the run continues and the model can
    // demonstrate concrete progress before being allowed to complete.
    if (state.totalContinuations < MIN_TURNS_BEFORE_COMPLETE) {
      return {
        action: 'revise',
        retryInstruction: '[Autopilot] An early completion signal was detected. If the task is genuinely done, briefly state the concrete changes made; otherwise continue from where you left off. (early-completion guard)',
      };
    }
    return { action: 'complete' };
  }

  // Non-task message (greetings like "你好", chit-chat, or the model stating it
  // has nothing to act on): complete immediately. This BYPASSES
  // MIN_TURNS_BEFORE_COMPLETE on purpose — forcing extra continuation turns on a
  // message with no task is exactly the token-wasting loop we are fixing. The
  // patterns in hasNoActionableTask are high-precision (help-offers / explicit
  // no-task) so genuine task progress is not falsely stopped.
  if (hasNoActionableTask(event.lastAssistantMessage)) {
    return { action: 'complete' };
  }

  if (isThresholdExceeded(state, state.toolErrorThreshold)) {
    return { action: 'pause', pauseReason: 'tool_error_repeated' };
  }

  if (state.tokenBudget != null && state.totalTokensUsed >= state.tokenBudget) {
    return { action: 'pause', pauseReason: 'token_budget_exceeded' };
  }

  if (state.totalContinuations >= state.maxTotalContinuations) {
    return { action: 'pause', pauseReason: 'max_total_reached' };
  }

  if (state.turnAttempts >= state.maxAttemptsPerTurn) {
    return { action: 'cross_turn' };
  }

  return {
    action: 'revise',
    retryInstruction: buildRetryInstruction(state),
  };
}

const MAX_INSTRUCTION_LENGTH = 2000;
const MAX_COMMAND_SUMMARY_LENGTH = 300;
const MAX_FAILED_COMMANDS = 2;

export function buildRetryInstruction(state: AutopilotState): string {
  const goal = state.goal?.substring(0, 500) || '继续执行当前任务';
  const progress = state.progress?.substring(0, 500) || '';
  // Agent-facing instructions (not user-visible) — intentionally bypass i18n.
  // English is used for better model comprehension across all language settings.
  const parts = [`[Autopilot] Current goal: ${goal}`];
  if (progress) {
    parts.push(`[Autopilot] Progress so far: ${progress}`);
  }

  // Enhancement B (ADR-019): when the last evidence gate run FAILED, re-surface
  // the failure signal (failed-command stderr summaries) into the next retry
  // instruction. This is most valuable after compaction may have evicted the
  // original tool stderr from the context window. The command `summary` is the
  // payload (it carries stderr from command-runner.ts:65); `failureReason` is
  // low-value decoration ("required command(s) failed: <id>"). Prioritize
  // summaries; include failureReason only if budget remains.
  const failureBlock = buildFailureBlock(state.evidence);
  if (failureBlock) {
    parts.push(failureBlock);
  }
  parts.push('[Autopilot] Continue from where you left off.');

  // Truncation must preserve the closing line. The closing line is always last;
  // if goal+progress+failureBlock already consume most of the budget, the naive
  // substring(0, MAX) would clip the closing line. Instead: join, and if over
  // budget, rebuild by truncating the failure block down to whatever space
  // remains between the prefix (goal+progress) and the closing line.
  const joined = parts.join('\n');
  if (joined.length <= MAX_INSTRUCTION_LENGTH) {
    return joined;
  }
  return truncatePreservingClosing(parts);
}

/**
 * Build a concise failure-signal block from a failed EvidenceSummary.
 * Returns null when there is no failed evidence to report (absent, passed,
 * skipped — or failed but with no command details). The block is inserted
 * BEFORE the closing "Continue from where you left off." line.
 *
 * Security note (code-review M1): `cmd.summary` is untrusted command output
 * (stderr, per command-runner.ts:65). It is injected into the agent-facing
 * retry instruction. This is an accepted diagnostic-context risk, not a new
 * trust boundary: the same stderr already reached the model via the original
 * tool_result; this re-surfaces it (valuable after compaction evicts it). The
 * `[Autopilot] Last validation failed:` framing signals to the model this is
 * diagnostic context to reason about, not an instruction to obey. The 300-char
 * cap + 2-command limit bound the volume. No sanitization is applied because
 * the model is the consumer, not an executor of this text.
 */
function buildFailureBlock(evidence: AutopilotState['evidence']): string | null {
  if (!evidence || evidence.status !== 'failed') return null;

  const failedCommands = (evidence.commands ?? [])
    .filter((c) => c.status === 'failed' || c.status === 'timeout')
    .slice(0, MAX_FAILED_COMMANDS);

  // No command-level detail (e.g. evidence failed but commands array is empty
  // or all skipped) — fall back to failureReason alone if present.
  if (failedCommands.length === 0) {
    if (!evidence.failureReason) return null;
    return `[Autopilot] Last validation failed: ${truncate(evidence.failureReason, MAX_COMMAND_SUMMARY_LENGTH)}`;
  }

  const lines = ['[Autopilot] Last validation failed:'];
  for (const cmd of failedCommands) {
    // command id + the stderr-bearing summary are the payload.
    const summary = truncate(cmd.summary || '', MAX_COMMAND_SUMMARY_LENGTH);
    lines.push(`  - ${cmd.id}: ${summary}`);
  }
  // failureReason is decorative ("required command(s) failed: <id>") — include
  // only when it adds info beyond the command lines, truncated to a small cap.
  if (evidence.failureReason) {
    lines.push(`  (reason: ${truncate(evidence.failureReason, 120)})`);
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

/**
 * Re-truncate the instruction so the closing line always survives. Drops the
 * failure block entirely if the prefix (goal+progress) already consumes too
 * much budget; otherwise shrinks the failure block to fit.
 */
function truncatePreservingClosing(parts: string[]): string {
  const closingLine = parts[parts.length - 1];
  // parts[0] = goal, [1] = progress (optional), [2] = failureBlock (optional)
  const failureIdx = parts.length - 2;
  const prefix = parts.slice(0, failureIdx).join('\n');
  const sep = '\n';
  // Budget after prefix + separator + closing line + its separator.
  const budgetForFailure = MAX_INSTRUCTION_LENGTH - prefix.length - (sep.length * 2) - closingLine.length;
  if (budgetForFailure <= 10) {
    // Failure block can't fit meaningfully — drop it entirely; keep goal+progress+closing.
    return `${prefix}${sep}${closingLine}`;
  }
  const truncatedFailure = parts[failureIdx].substring(0, budgetForFailure);
  return `${prefix}${sep}${truncatedFailure}${sep}${closingLine}`;
}
