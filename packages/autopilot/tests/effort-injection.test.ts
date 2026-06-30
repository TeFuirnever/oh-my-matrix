/**
 * Tests: graduated thinking intensity + dynamic phase resolution.
 * Pure functions — no side effects, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { buildEffortInjection, resolveThinkingIntensity } from '../src/effort-injection';

describe('buildEffortInjection', () => {
  describe('when status is not running', () => {
    it('returns null regardless of intensity', () => {
      expect(buildEffortInjection('idle')).toBeNull();
      expect(buildEffortInjection('idle', 'high')).toBeNull();
      expect(buildEffortInjection('paused', 'medium')).toBeNull();
      expect(buildEffortInjection('done', 'low')).toBeNull();
    });
  });

  describe('when status is running', () => {
    it('defaults to high when intensity omitted (backward compat)', () => {
      expect(buildEffortInjection('running')).toBe(
        '[autopilot-effort] Use high effort (extended thinking) for this turn.',
      );
    });

    it('low → standard-effort text (no extended thinking)', () => {
      const r = buildEffortInjection('running', 'low');
      expect(r).toContain('standard effort');
      expect(r).not.toContain('extended thinking');
    });

    it('medium → moderate-effort text', () => {
      expect(buildEffortInjection('running', 'medium')).toContain('moderate effort');
    });

    it('high → extended-thinking text (same string as before graduation)', () => {
      const r = buildEffortInjection('running', 'high');
      expect(r).toContain('high effort');
      expect(r).toContain('extended thinking');
    });
  });
});

describe('resolveThinkingIntensity', () => {
  it('evidence running → low (validation phase)', () => {
    expect(resolveThinkingIntensity(5, 'running', 'high')).toBe('low');
  });

  it('totalContinuations <= 1 → high (initial turns)', () => {
    expect(resolveThinkingIntensity(0, undefined, 'medium')).toBe('high');
    expect(resolveThinkingIntensity(1, undefined, 'medium')).toBe('high');
  });

  it('otherwise → configured intensity', () => {
    expect(resolveThinkingIntensity(5, undefined, 'medium')).toBe('medium');
    expect(resolveThinkingIntensity(10, undefined, 'low')).toBe('low');
  });

  it('defaults to high when configIntensity omitted', () => {
    expect(resolveThinkingIntensity(5, undefined)).toBe('high');
  });

  it('evidence running overrides the initial-turn heuristic', () => {
    expect(resolveThinkingIntensity(0, 'running', 'high')).toBe('low');
  });

  it('non-running evidence statuses fall through to phase/config logic', () => {
    expect(resolveThinkingIntensity(5, 'passed', 'medium')).toBe('medium');
    expect(resolveThinkingIntensity(0, 'failed', 'medium')).toBe('high');
    expect(resolveThinkingIntensity(5, 'not_started', 'low')).toBe('low');
  });
});
