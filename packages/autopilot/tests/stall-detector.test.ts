/**
 * M2.5 TDD Tests: Stall Detector
 *
 * Tests last activity tracking, timeout only while running,
 * and no stall detection while paused/done.
 */
import { describe, it, expect } from 'vitest';
import {
  checkStall,
} from '../src/stall-detector';

describe('stall-detector', () => {
  const STALL_TIMEOUT_MS = 300000; // 5 min default

  describe('checkStall', () => {
    it('not stalled when lastActivityAt is undefined', () => {
      const result = checkStall({
        orchestrationState: 'running',
        lastActivityAt: undefined,
        now: 1000000,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });

    it('not stalled when within timeout', () => {
      const result = checkStall({
        orchestrationState: 'running',
        lastActivityAt: 900000,
        now: 1000000,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });

    it('stalled when exceeded timeout while running', () => {
      const result = checkStall({
        orchestrationState: 'running',
        lastActivityAt: 100000,
        now: 500000,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(true);
      expect(result.stallDurationMs).toBe(100000);
    });

    it('not stalled when exactly at timeout boundary', () => {
      const result = checkStall({
        orchestrationState: 'running',
        lastActivityAt: 100000,
        now: 400000,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      // Exactly at boundary — not stalled (need > not >=)
      expect(result.stalled).toBe(false);
    });

    it('stalled when just past timeout boundary', () => {
      const result = checkStall({
        orchestrationState: 'running',
        lastActivityAt: 100000,
        now: 400001,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(true);
    });

    it('not stalled when orchestrationState is paused', () => {
      const result = checkStall({
        orchestrationState: 'retry_queued',
        lastActivityAt: 100000,
        now: 999999999,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });

    it('not stalled when orchestrationState is blocked', () => {
      const result = checkStall({
        orchestrationState: 'blocked',
        lastActivityAt: 100000,
        now: 999999999,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });

    it('not stalled when orchestrationState is done', () => {
      const result = checkStall({
        orchestrationState: 'done',
        lastActivityAt: 100000,
        now: 999999999,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });

    it('not stalled when orchestrationState is unclaimed', () => {
      const result = checkStall({
        orchestrationState: 'unclaimed',
        lastActivityAt: 100000,
        now: 999999999,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });

    it('not stalled when orchestrationState is released', () => {
      const result = checkStall({
        orchestrationState: 'released',
        lastActivityAt: 100000,
        now: 999999999,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });

    it('uses custom stallTimeoutMs', () => {
      const result = checkStall({
        orchestrationState: 'running',
        lastActivityAt: 100000,
        now: 200000,
        stallTimeoutMs: 50000, // 50s custom
      });
      expect(result.stalled).toBe(true);
    });

    it('returns correct stallDurationMs', () => {
      const result = checkStall({
        orchestrationState: 'running',
        lastActivityAt: 100000,
        now: 500000,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(true);
      expect(result.stallDurationMs).toBe(100000);
    });

    // ── M3: claimed state stall detection ──────────────────────────
    // A run stuck in 'claimed' (never receives a turn) was previously invisible
    // to the stall detector — it only checked 'running'. The only recovery was
    // the 24h orphan sweep. Now 'claimed' is also checked (with the same threshold).

    it('M3: stalled when claimed and exceeded timeout', () => {
      const result = checkStall({
        orchestrationState: 'claimed',
        lastActivityAt: 100000,
        now: 500000,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(true);
    });

    it('M3: not stalled when claimed but within timeout', () => {
      const result = checkStall({
        orchestrationState: 'claimed',
        lastActivityAt: 900000,
        now: 1000000,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });

    it('M3: not stalled when claimed and lastActivityAt is undefined', () => {
      const result = checkStall({
        orchestrationState: 'claimed',
        lastActivityAt: undefined,
        now: 1000000,
        stallTimeoutMs: STALL_TIMEOUT_MS,
      });
      expect(result.stalled).toBe(false);
    });
  });
});

