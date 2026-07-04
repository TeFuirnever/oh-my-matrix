/**
 * W1 Phase 1: deriveStatus derivation table — the specification for how
 * `status` should be derived from `orchestrationState` + `blockedReason`.
 *
 * This test is PURELY ADDITIVE in Phase 1 — deriveStatus exists but no
 * production writer uses it yet. It documents the intended mapping so Phase 2
 * has a golden spec to route writers against.
 *
 * The table is exhaustive over (orchestrationState × blockedReason) pairs that
 * the reducer can produce. If deriveStatus returns the wrong value for any
 * cell, a Phase-2 writer that trusts it would silently produce the wrong status.
 */
import { describe, it, expect } from 'vitest';
import { deriveStatus, RESUMABLE_BLOCKED_REASONS } from '../src/orchestrator';
import type { BlockedReason, OrchestrationState } from '../src/types';

describe('W1 deriveStatus — status derivation table', () => {
  // Every orchState that maps to 'running' (active family).
  describe.each([
    ['unclaimed'],
    ['claimed'],
    ['running'],
    ['released'],
    ['retry_queued'],
  ] as const)('orchState=%s → running', (orch) => {
    it('derives running (regardless of blockedReason)', () => {
      expect(deriveStatus({ orchestrationState: orch, blockedReason: undefined })).toBe('running');
    });
  });

  it('orchState=done → done', () => {
    expect(deriveStatus({ orchestrationState: 'done', blockedReason: undefined })).toBe('done');
  });

  // blocked splits on blockedReason.
  describe('blocked splits on blockedReason', () => {
    it('blocked + user_stopped → idle (terminal, user-initiated)', () => {
      expect(deriveStatus({ orchestrationState: 'blocked', blockedReason: 'user_stopped' })).toBe('idle');
    });

    // Resumable reasons → paused (recoverable).
    describe.each(
      [...RESUMABLE_BLOCKED_REASONS].map((r) => [r] as const),
    )('blocked + %s (resumable) → paused', (reason) => {
      it('derives paused', () => {
        expect(deriveStatus({ orchestrationState: 'blocked', blockedReason: reason })).toBe('paused');
      });
    });

    // Non-resumable, non-user_stopped reasons → paused (parked).
    const allBlockedReasons: BlockedReason[] = [
      'permission_denied', 'workspace_containment_failed', 'workspace_create_failed',
      'validation_failed', 'evidence_missing', 'stalled', 'token_budget_exceeded',
      'user_stopped', 'config_invalid', 'max_retries_reached',
    ];
    const nonResumableNonUser = allBlockedReasons.filter(
      (r) => r !== 'user_stopped' && !RESUMABLE_BLOCKED_REASONS.has(r),
    );
    describe.each(
      nonResumableNonUser.map((r) => [r] as const),
    )('blocked + %s (non-resumable) → paused', (reason) => {
      it('derives paused (parked)', () => {
        expect(deriveStatus({ orchestrationState: 'blocked', blockedReason: reason })).toBe('paused');
      });
    });
  });

  it('every OrchestrationState value has a defined derivation (no undefined returns)', () => {
    const allOrch: OrchestrationState[] = [
      'unclaimed', 'claimed', 'running', 'retry_queued', 'released', 'blocked', 'done',
    ];
    for (const orch of allOrch) {
      const result = deriveStatus({ orchestrationState: orch, blockedReason: undefined });
      expect(result).toBeDefined();
      expect(['running', 'paused', 'idle', 'done']).toContain(result);
    }
  });
});
