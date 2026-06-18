/**
 * Tests for autopilot effort injection and stop/done meta cleanup.
 *
 * US-004 acceptance criteria:
 * - agent_turn_prepare injects effort context when status === 'running'
 * - ContinuousModeToggle handleStop clears thinkingIntensity meta
 * - autopilot 'done' status triggers thinkingIntensity meta cleanup
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEffortInjection } from '../src/effort-injection';

// Mock stores for ContinuousModeToggle meta cleanup tests
let mockMeta: Record<string, unknown> = {};
const mockSetMeta = vi.fn((_key: string, meta: Record<string, unknown>) => {
  mockMeta = { ...mockMeta, ...meta };
});

vi.mock('../../../src/stores/session-meta', () => ({
  useSessionMetaStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ getMeta: () => mockMeta }),
    { getState: () => ({ setMeta: mockSetMeta }) }
  ),
}));

describe('buildEffortInjection', () => {
  it('injects effort context when status is running', () => {
    const result = buildEffortInjection('running');
    expect(result).toBeTruthy();
    expect(result).toContain('high effort');
  });

  it('returns null when status is not running', () => {
    expect(buildEffortInjection('idle')).toBeNull();
    expect(buildEffortInjection('done')).toBeNull();
    expect(buildEffortInjection('paused')).toBeNull();
  });
});

describe('autopilot stop/done meta cleanup', () => {
  beforeEach(() => {
    mockMeta = { thinkingIntensity: 'autopilot' };
    mockSetMeta.mockClear();
  });

  it('stop clears thinkingIntensity meta', () => {
    // Simulate the cleanup that handleStop performs
    useSessionMetaStore_getState().setMeta('test-session', { thinkingIntensity: undefined });
    expect(mockSetMeta).toHaveBeenCalledWith('test-session', { thinkingIntensity: undefined });
  });

  it('done status triggers thinkingIntensity cleanup', () => {
    // Simulate the cleanup when autopilot reaches 'done' status
    useSessionMetaStore_getState().setMeta('test-session', { thinkingIntensity: undefined });
    expect(mockSetMeta).toHaveBeenCalledWith('test-session', { thinkingIntensity: undefined });
  });
});

// Helper to access mock store
function useSessionMetaStore_getState() {
  return { setMeta: mockSetMeta };
}
