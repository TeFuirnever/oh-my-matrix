import { describe, it, expect } from 'vitest';
import {
  trackToolError,
  isThresholdExceeded,
} from '../src/tool-error-tracker';
import { createInitialState, type AutopilotState } from '../src/types';

function runningState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return {
    ...createInitialState('session-1', 'run-1'),
    status: 'running',
    enabled: true,
    ...overrides,
  };
}

describe('tool-error-tracker', () => {
  describe('trackToolError', () => {
    it('records first tool error with count 1', () => {
      const state = runningState();
      const next = trackToolError(state, { tool: 'bash', args: 'npm test', error: 'exit 1' });
      expect(next.lastToolError).toEqual({ tool: 'bash', args: 'npm test', error: 'exit 1' });
      expect(next.toolErrorCount).toBe(1);
    });

    it('increments count for same tool+args repeated error', () => {
      const state = runningState({
        lastToolError: { tool: 'bash', args: 'npm test', error: 'exit 1' },
        toolErrorCount: 2,
      });
      const next = trackToolError(state, { tool: 'bash', args: 'npm test', error: 'exit 1' });
      expect(next.toolErrorCount).toBe(3);
    });

    it('resets count when tool changes', () => {
      const state = runningState({
        lastToolError: { tool: 'bash', args: 'npm test', error: 'exit 1' },
        toolErrorCount: 2,
      });
      const next = trackToolError(state, { tool: 'read', args: '/tmp/file.ts', error: 'ENOENT' });
      expect(next.toolErrorCount).toBe(1);
      expect(next.lastToolError!.tool).toBe('read');
    });

    it('resets count when args change for same tool', () => {
      const state = runningState({
        lastToolError: { tool: 'bash', args: 'npm test', error: 'exit 1' },
        toolErrorCount: 2,
      });
      const next = trackToolError(state, { tool: 'bash', args: 'npm run build', error: 'exit 1' });
      expect(next.toolErrorCount).toBe(1);
    });

    // M3: Alternating errors between two tools never trigger threshold
    // This is a known design limitation — document it with a regression test
    it('alternating errors between two tools never reach threshold (known behavior)', () => {
      let state = runningState();
      // Alternate between tool A and tool B — each resets count to 1
      for (let i = 0; i < 10; i++) {
        state = trackToolError(state, { tool: 'bash', args: 'npm test', error: 'exit 1' });
        expect(state.toolErrorCount).toBe(1); // Always resets for new tool
        state = trackToolError(state, { tool: 'read', args: '/file', error: 'ENOENT' });
        expect(state.toolErrorCount).toBe(1); // Always resets for new tool
      }
      // After 20 errors total, threshold is still 1 — never reaches 3
      expect(isThresholdExceeded(state, 3)).toBe(false);
    });
  });

  describe('isThresholdExceeded', () => {
    it('returns false when count is below threshold', () => {
      const state = runningState({ toolErrorCount: 2 });
      expect(isThresholdExceeded(state, 3)).toBe(false);
    });

    it('returns true when count equals threshold', () => {
      const state = runningState({ toolErrorCount: 3 });
      expect(isThresholdExceeded(state, 3)).toBe(true);
    });

    it('returns true when count exceeds threshold', () => {
      const state = runningState({ toolErrorCount: 5 });
      expect(isThresholdExceeded(state, 3)).toBe(true);
    });

    it('returns false when no tool error exists', () => {
      const state = runningState({ toolErrorCount: 0, lastToolError: undefined });
      expect(isThresholdExceeded(state, 3)).toBe(false);
    });
  });
});
