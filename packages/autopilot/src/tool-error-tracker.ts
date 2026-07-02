import type { AutopilotState, ToolErrorEntry } from './types';

/**
 * Track a failed tool call for the loop-breaker (isThresholdExceeded → pause with
 * 'tool_error_repeated'). Counts CONSECUTIVE identical failures (same tool AND
 * same args); any different failure resets the count to 1. Successful calls do
 * not reach here (after_tool_call only tracks when event.error is set), so they
 * neither increment nor reset — a success between two identical failures still
 * counts as consecutive.
 *
 * Deliberately narrow: "the same call failing over and over" is a precise stuck
 * signal. Widening it (count total errors, or match on tool alone) would misfire
 * on normal trial-and-error — an agent trying different commands, some of which
 * fail, is making progress, not stuck. The known blind spot (an agent alternating
 * between two DIFFERENT failing calls forever, A→B→A→B, never trips this) is
 * accepted: the other loop-breakers (maxTotalContinuations, stall detector) catch
 * it. Erring toward not-halting-real-work beats a false pause. (BUG-TET-1 review)
 */
export function trackToolError(
  state: AutopilotState,
  error: ToolErrorEntry,
): AutopilotState {
  const isSameError =
    state.lastToolError &&
    state.lastToolError.tool === error.tool &&
    state.lastToolError.args === error.args;

  return {
    ...state,
    lastToolError: error,
    toolErrorCount: isSameError ? state.toolErrorCount + 1 : 1,
  };
}

export function isThresholdExceeded(
  state: AutopilotState,
  threshold: number,
): boolean {
  return state.toolErrorCount >= threshold;
}
