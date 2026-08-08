/**
 * Tests for autopilot activate idempotency.
 *
 * US-003 acceptance criteria:
 * - activate handler rejects duplicate activation for already-running session
 * - Re-activation from 'done' state succeeds
 */
import { describe, it, expect } from 'vitest';
import { activate, complete, pause, isRunStuck } from '../src/autopilot-state';
import { createInitialState, type AutopilotState } from '../src/types';

describe('activate idempotency', () => {
  it('rejects activation when session is already running', () => {
    const state = createInitialState('test-session', 'run-1');
    const running = activate(state); // idle → running
    expect(() => activate(running)).toThrow('Cannot activate from status "running"');
  });

  it('rejects activation when session is paused', () => {
    const state = createInitialState('test-session', 'run-1');
    const running = activate(state);
    const paused = pause(running, 'loop_breaker_triggered');
    expect(() => activate(paused)).toThrow('Cannot activate from status "paused"');
  });

  it('allows re-activation from done state (done → running)', () => {
    const state = createInitialState('test-session', 'run-1');
    const running = activate(state);
    const done = complete(running);
    const reactivated = activate(done);
    expect(reactivated.status).toBe('running');
    expect(reactivated.enabled).toBe(true);
  });
});

// ─── isRunStuck: stuck-running recovery decision (diagnose 2026-06-12) ──────
// A session that stalled sits in status='running' with orchState='retry_queued'
// (the stall handler doesn't pause). Without recovery it blocks re-activation
// forever. isRunStuck decides whether activate may discard + restart it.

describe('isRunStuck', () => {
  const NOW = 1_000_000;
  const STALL_MS = 600_000;

  function runningState(overrides: Partial<AutopilotState> = {}): AutopilotState {
    return { ...activate(createInitialState('s', 'r')), ...overrides };
  }

  it('detects a stalled run via orchestrationState=retry_queued', () => {
    // The stall handler sets retry_queued while leaving status='running'.
    const state = runningState({ orchestrationState: 'retry_queued', lastActivityAt: NOW });
    expect(isRunStuck(state, NOW, STALL_MS)).toBe(true);
  });

  it('E10/P2-17: retry_queued with future nextRetryAt is NOT stuck (backoff)', () => {
    // A run waiting out its retry backoff is recovering, not stuck — re-activate
    // must not discard it. (No retry field => still stuck, covered above.)
    const state = runningState({
      orchestrationState: 'retry_queued',
      retry: { attempt: 1, nextRetryAt: NOW + 60_000, lastError: 'stalled', recoverable: true },
      lastActivityAt: NOW,
    });
    expect(isRunStuck(state, NOW, STALL_MS)).toBe(false);
  });

  it('E10/P2-17: retry_queued with OVERDUE nextRetryAt IS stuck', () => {
    // Backoff window elapsed but the run is still retry_queued — genuinely stuck.
    const state = runningState({
      orchestrationState: 'retry_queued',
      retry: { attempt: 1, nextRetryAt: NOW - 1_000, lastError: 'stalled', recoverable: true },
      lastActivityAt: NOW,
    });
    expect(isRunStuck(state, NOW, STALL_MS)).toBe(true);
  });

  it('returns false for a genuinely-active run (recent activity)', () => {
    const state = runningState({ orchestrationState: 'running', lastActivityAt: NOW });
    expect(isRunStuck(state, NOW, STALL_MS)).toBe(false);
  });

  it('detects a stale run via lastActivityAt beyond stallTimeout', () => {
    // Agent likely dead — no activity for longer than the threshold.
    const state = runningState({ orchestrationState: 'running', lastActivityAt: NOW - STALL_MS - 1 });
    expect(isRunStuck(state, NOW, STALL_MS)).toBe(true);
  });

  it('falls back to startedAt when lastActivityAt is absent', () => {
    const state = runningState({ orchestrationState: 'running', lastActivityAt: undefined, startedAt: NOW - STALL_MS - 1 });
    expect(isRunStuck(state, NOW, STALL_MS)).toBe(true);
  });

  it('does not flag a stale run that still has activity within threshold', () => {
    const state = runningState({ orchestrationState: 'running', lastActivityAt: NOW - 1000 });
    expect(isRunStuck(state, NOW, STALL_MS)).toBe(false);
  });

  it('returns false for idle / done (not running)', () => {
    const idle = createInitialState('s', 'r');
    const done = complete(activate(idle));
    expect(isRunStuck(idle, NOW, STALL_MS)).toBe(false);
    expect(isRunStuck(done, NOW, STALL_MS)).toBe(false);
  });

  it('returns false for paused (intentional, user-resumable — out of scope)', () => {
    const paused = pause(activate(createInitialState('s', 'r')), 'loop_breaker_triggered');
    expect(isRunStuck(paused, NOW, STALL_MS)).toBe(false);
  });

  it('retry_queued is stuck even with no lastActivityAt/startedAt', () => {
    const state = runningState({ orchestrationState: 'retry_queued', lastActivityAt: undefined, startedAt: undefined });
    expect(isRunStuck(state, NOW, STALL_MS)).toBe(true);
  });
});
