import type { AutopilotState } from './types';
import { setGoal, snapshotGoal, restoreGoalFromSnapshot } from './autopilot-state';

export function captureGoal(state: AutopilotState, userMessage: string): AutopilotState {
  if (!state.enabled || !userMessage.trim()) return state;
  return setGoal(state, userMessage.trim());
}

export function preserveGoalBeforeCompaction(state: AutopilotState): AutopilotState {
  if (!state.enabled || !state.goal) return state;
  return snapshotGoal(state);
}

export function restoreGoalAfterCompaction(state: AutopilotState): AutopilotState {
  if (!state.enabled) return state;
  return restoreGoalFromSnapshot(state);
}
