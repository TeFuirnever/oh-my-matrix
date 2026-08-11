/**
 * M2.6 TDD Tests: Evidence Gate
 *
 * Tests diff summary, command pass/fail/timeout/skipped,
 * required vs optional command failure, and completion verification.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateEvidence,
  summarizeDiff,


} from '../src/evidence-gate';
import type { EvidenceCommandResult } from '../src/types';

describe('evidence-gate', () => {
  describe('evaluateEvidence', () => {
    const NOW = Date.now();

    it('returns passed when all required commands pass', () => {
      const result = evaluateEvidence({
        commands: [
          { id: 'typecheck', command: 'pnpm run typecheck', timeoutMs: 120000, required: true },
          { id: 'unit', command: 'pnpm exec vitest run tests/unit/autopilot', timeoutMs: 120000, required: true },
        ],
        results: [
          { id: 'typecheck', command: 'pnpm run typecheck', status: 'passed', exitCode: 0, durationMs: 3000, summary: '0 errors' },
          { id: 'unit', command: 'pnpm exec vitest run tests/unit/autopilot', status: 'passed', exitCode: 0, durationMs: 5000, summary: '94 tests passed' },
        ],
        diffSummary: '3 files changed, 50 insertions(+), 10 deletions(-)',
        now: NOW,
      });
      expect(result.status).toBe('passed');
      expect(result.diffSummary).toBe('3 files changed, 50 insertions(+), 10 deletions(-)');
      expect(result.completedAt).toBe(NOW);
      expect(result.commands).toHaveLength(2);
    });

    it('returns failed when a required command fails', () => {
      const result = evaluateEvidence({
        commands: [
          { id: 'typecheck', command: 'pnpm run typecheck', timeoutMs: 120000, required: true },
        ],
        results: [
          { id: 'typecheck', command: 'pnpm run typecheck', status: 'failed', exitCode: 1, durationMs: 2000, summary: '2 errors found' },
        ],
        diffSummary: '1 file changed',
        now: NOW,
      });
      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('typecheck');
    });

    it('returns skipped/not_executed when a required command times out', () => {
      const result = evaluateEvidence({
        commands: [
          { id: 'slow-test', command: 'pnpm test', timeoutMs: 5000, required: true },
        ],
        results: [
          { id: 'slow-test', command: 'pnpm test', status: 'timeout', durationMs: 5001, summary: 'timed out after 5001ms' },
        ],
        diffSummary: '',
        now: NOW,
      });
      // V1: timeout is "configured but didn't run" → not_executed (blocked
      // evidence_missing, resumable), not a hard failure (design §3.1).
      expect(result.status).toBe('skipped');
      expect(result.skipReason).toBe('not_executed');
      expect(result.failureReason).toContain('slow-test');
    });

    it('returns passed when optional command fails', () => {
      const result = evaluateEvidence({
        commands: [
          { id: 'typecheck', command: 'pnpm run typecheck', timeoutMs: 120000, required: true },
          { id: 'lint', command: 'pnpm lint', timeoutMs: 60000, required: false },
        ],
        results: [
          { id: 'typecheck', command: 'pnpm run typecheck', status: 'passed', exitCode: 0, durationMs: 3000, summary: '0 errors' },
          { id: 'lint', command: 'pnpm lint', status: 'failed', exitCode: 1, durationMs: 1000, summary: '3 warnings' },
        ],
        diffSummary: '',
        now: NOW,
      });
      expect(result.status).toBe('passed');
    });

    it('returns failed when optional fails and failOnOptional=true', () => {
      const result = evaluateEvidence({
        commands: [
          { id: 'typecheck', command: 'pnpm run typecheck', timeoutMs: 120000, required: true },
          { id: 'lint', command: 'pnpm lint', timeoutMs: 60000, required: false },
        ],
        results: [
          { id: 'typecheck', command: 'pnpm run typecheck', status: 'passed', exitCode: 0, durationMs: 3000, summary: '0 errors' },
          { id: 'lint', command: 'pnpm lint', status: 'failed', exitCode: 1, durationMs: 1000, summary: '3 warnings' },
        ],
        diffSummary: '',
        now: NOW,
        failOnOptional: true,
      });
      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('lint');
    });

    it('returns skipped when no validation commands configured', () => {
      const result = evaluateEvidence({
        commands: [],
        results: [],
        diffSummary: '',
        now: NOW,
      });
      expect(result.status).toBe('skipped');
      expect(result.failureReason).toContain('no validation commands');
      // E4: explicit skipReason so the gate can tell not_configured (legit → done)
      // from not_executed (configured but didn't run → blocked evidence_missing).
      expect(result.skipReason).toBe('not_configured');
    });

    it('returns passed when all commands are skipped (non-required)', () => {
      const result = evaluateEvidence({
        commands: [
          { id: 'optional', command: 'echo hello', timeoutMs: 1000, required: false },
        ],
        results: [
          { id: 'optional', command: 'echo hello', status: 'skipped', durationMs: 0, summary: 'skipped' },
        ],
        diffSummary: '',
        now: NOW,
      });
      expect(result.status).toBe('passed');
    });

    it('includes diff summary in result', () => {
      const result = evaluateEvidence({
        commands: [{ id: 't', command: 'true', timeoutMs: 1000, required: true }],
        results: [{ id: 't', command: 'true', status: 'passed', exitCode: 0, durationMs: 1, summary: 'ok' }],
        diffSummary: '5 files changed, 200 insertions(+), 30 deletions(-)',
        now: NOW,
      });
      expect(result.diffSummary).toBe('5 files changed, 200 insertions(+), 30 deletions(-)');
    });

    it('handles missing results for commands as skipped', () => {
      const result = evaluateEvidence({
        commands: [
          { id: 'typecheck', command: 'pnpm run typecheck', timeoutMs: 120000, required: true },
        ],
        results: [], // No results — command was never run
        diffSummary: '',
        now: NOW,
      });
      // V1: required command missing → not_executed (blocked evidence_missing,
      // resumable), not a hard failure (design §3.1: 命令缺失 → blocked).
      expect(result.status).toBe('skipped');
      expect(result.skipReason).toBe('not_executed');
    });

    it('includes command results in output', () => {
      const results: EvidenceCommandResult[] = [
        { id: 'typecheck', command: 'pnpm run typecheck', status: 'passed', exitCode: 0, durationMs: 3000, summary: 'ok' },
      ];
      const result = evaluateEvidence({
        commands: [{ id: 'typecheck', command: 'pnpm run typecheck', timeoutMs: 120000, required: true }],
        results,
        diffSummary: '',
        now: NOW,
      });
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].status).toBe('passed');
    });

    it('multiple failures: failure reason lists all failed commands', () => {
      const result = evaluateEvidence({
        commands: [
          { id: 'typecheck', command: 'pnpm run typecheck', timeoutMs: 120000, required: true },
          { id: 'test', command: 'pnpm test', timeoutMs: 120000, required: true },
        ],
        results: [
          { id: 'typecheck', command: 'pnpm run typecheck', status: 'failed', exitCode: 1, durationMs: 2000, summary: 'err' },
          { id: 'test', command: 'pnpm test', status: 'failed', exitCode: 1, durationMs: 3000, summary: 'err' },
        ],
        diffSummary: '',
        now: NOW,
      });
      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('typecheck');
      expect(result.failureReason).toContain('test');
    });
  });

  describe('summarizeDiff', () => {
    it('formats git diff --stat output', () => {
      expect(summarizeDiff('3 files changed, 50 insertions(+), 10 deletions(-)'))
        .toBe('3 files changed, 50 insertions(+), 10 deletions(-)');
    });

    it('returns empty string for empty diff', () => {
      expect(summarizeDiff('')).toBe('');
    });

    it('truncates very long diff output to 500 chars', () => {
      const longDiff = 'a'.repeat(600);
      const result = summarizeDiff(longDiff);
      expect(result.length).toBeLessThanOrEqual(500);
    });

    it('handles null/undefined gracefully', () => {
      expect(summarizeDiff(null as unknown as string)).toBe('');
      expect(summarizeDiff(undefined as unknown as string)).toBe('');
    });
  });
});
