import type { AutopilotState, ToolErrorEntry } from './types';

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
