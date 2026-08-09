/**
 * E8 / P3-20: shouldCheckpoint must trigger on a totalContinuations change
 * directly, not piggyback on a `progress` string change. Before E8 the turn
 * count reached disk only when `progress` also changed — fragile (a turn with
 * no progress shift was lost). shouldCheckpoint had zero coverage; this pins it.
 */
import { describe, it, expect } from 'vitest';
import { shouldCheckpoint } from '../index';
import { createInitialState } from '../src/types';

describe('E8 — shouldCheckpoint triggers', () => {
  it('a totalContinuations change triggers a checkpoint (not piggybacked on progress)', () => {
    const prev = createInitialState('sess-1', 'run-1');
    const next = { ...prev, totalContinuations: prev.totalContinuations + 1 };
    expect(shouldCheckpoint(prev, next)).toBe(true);
  });

  it('a progress-only change still triggers (existing behavior preserved)', () => {
    const prev = createInitialState('sess-1', 'run-1');
    const next = { ...prev, progress: 'Turn 1/50' };
    expect(shouldCheckpoint(prev, next)).toBe(true);
  });

  it('an unchanged state does not trigger', () => {
    const s = createInitialState('sess-1', 'run-1');
    expect(shouldCheckpoint(s, s)).toBe(false);
  });

  it('a missing prev (first write) triggers', () => {
    const s = createInitialState('sess-1', 'run-1');
    expect(shouldCheckpoint(undefined, s)).toBe(true);
  });

  it('needsCrossTurnResume flip triggers (E13: resume_run consumption must reach disk)', () => {
    const before = { ...createInitialState('sess-1', 'run-1'), needsCrossTurnResume: true };
    const after = { ...before, needsCrossTurnResume: false };
    expect(shouldCheckpoint(before, after)).toBe(true);
    // No-op when the flag never changed.
    const unchanged = { ...before, needsCrossTurnResume: true };
    expect(shouldCheckpoint(before, unchanged)).toBe(false);
  });
});
