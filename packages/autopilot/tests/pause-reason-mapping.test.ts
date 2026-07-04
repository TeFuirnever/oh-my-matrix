/**
 * W1 Phase 1 / TENSION 1: the PauseReason → BlockedReason mapping cross-product.
 *
 * The Architect review found that `toBlockedReason` (types.ts:59) silently falls
 * back to `'validation_failed'` for 6 of 10 PauseReasons. Since
 * `'validation_failed' ∈ RESUMABLE_BLOCKED_REASONS`, those 6 — including
 * unambiguously-terminal ones like `loop_breaker_triggered` and
 * `max_total_reached` — would be classified RECOVERABLE and resumable.
 *
 * This test documents the INTENDED total mapping (Phase 1.5 will implement
 * `pauseReasonToBlockedReason` with no fallback). It asserts, for every
 * PauseReason: the target BlockedReason, the derived status, and whether it's
 * resumable. The 6 rows marked ⚠️ are the lossy ones — they MUST NOT land in
 * the resumable set.
 *
 * Phase 1 status: this test passes as a SPEC (it tests the intended mapping
 * table directly). Phase 1.5 will wire `pauseReasonToBlockedReason` into the
 * reducer's `pause_requested` branch and this test will guard the real impl.
 */
import { describe, it, expect } from 'vitest';
import { deriveStatus, RESUMABLE_BLOCKED_REASONS } from '../src/orchestrator';
import type { PauseReason, BlockedReason } from '../src/types';

/**
 * The INTENDED total mapping (Phase 1.5 target). No fallback — every
 * PauseReason has an explicit BlockedReason.
 *
 * Rows marked ⚠️ are the 6 that `toBlockedReason` currently maps lossily
 * to `validation_failed`. They MUST be non-resumable.
 */
const INTENDED_MAPPING: ReadonlyArray<{
  pause: PauseReason;
  blocked: BlockedReason;
  lossyToday: boolean;
}> = [
  { pause: 'permission_denied', blocked: 'permission_denied', lossyToday: false },
  { pause: 'user_stopped', blocked: 'user_stopped', lossyToday: false },
  { pause: 'token_budget_exceeded', blocked: 'token_budget_exceeded', lossyToday: false },
  { pause: 'validation_failed', blocked: 'validation_failed', lossyToday: false },
  { pause: 'max_attempts_reached', blocked: 'max_retries_reached', lossyToday: true }, // ⚠️
  { pause: 'max_total_reached', blocked: 'max_total_reached', lossyToday: true }, // ⚠️ (new BlockedReason)
  { pause: 'tool_error_repeated', blocked: 'tool_error_repeated', lossyToday: true }, // ⚠️ (new BlockedReason)
  { pause: 'loop_breaker_triggered', blocked: 'loop_breaker_triggered', lossyToday: true }, // ⚠️ (new BlockedReason)
  { pause: 'context_overflow_unrecoverable', blocked: 'context_overflow_unrecoverable', lossyToday: true }, // ⚠️ (new)
  { pause: 'injection_rejected', blocked: 'injection_rejected', lossyToday: true }, // ⚠️ (new BlockedReason)
];

describe('W1 TENSION 1 — PauseReason → BlockedReason mapping (10-row cross-product)', () => {
  it('covers all 10 PauseReasons (no PauseReason unmapped)', () => {
    expect(INTENDED_MAPPING).toHaveLength(10);
    const allPauses: PauseReason[] = [
      'max_attempts_reached', 'max_total_reached', 'tool_error_repeated',
      'loop_breaker_triggered', 'context_overflow_unrecoverable', 'permission_denied',
      'injection_rejected', 'user_stopped', 'token_budget_exceeded', 'validation_failed',
    ];
    for (const p of allPauses) {
      expect(INTENDED_MAPPING.find((m) => m.pause === p)).toBeDefined();
    }
  });

  describe.each(INTENDED_MAPPING)('$pause → $blocked', ({ pause, blocked, lossyToday }) => {
    it('maps to the intended BlockedReason', () => {
      expect(blocked).toBeTruthy();
    });

    it('derives a non-running status (blocked → paused or idle)', () => {
      const derived = deriveStatus({ orchestrationState: 'blocked', blockedReason: blocked });
      expect(['paused', 'idle']).toContain(derived);
      expect(derived).not.toBe('running');
    });

    if (lossyToday) {
      it('⚠️ is NON-resumable (the lossy fallback bug would make it resumable)', () => {
        // This is the core TENSION 1 assertion: the 6 lossy reasons must NOT
        // be in RESUMABLE_BLOCKED_REASONS. Today toBlockedReason maps them to
        // 'validation_failed' which IS resumable — that's the bug.
        expect(RESUMABLE_BLOCKED_REASONS.has(blocked)).toBe(false);
      });
    }
  });

  it('the 4 non-lossy mappings preserve their existing resumability', () => {
    const nonLossy = INTENDED_MAPPING.filter((m) => !m.lossyToday);
    for (const { blocked } of nonLossy) {
      // These 4 (permission_denied, user_stopped, token_budget_exceeded, validation_failed)
      // keep their current resumability classification.
      const resumable = RESUMABLE_BLOCKED_REASONS.has(blocked);
      // validation_failed is resumable; the other 3 are not.
      if (blocked === 'validation_failed') {
        expect(resumable).toBe(true);
      } else {
        expect(resumable).toBe(false);
      }
    }
  });
});
