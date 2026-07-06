/**
 * Tests: graduated thinking intensity + dynamic phase resolution.
 * Pure functions — no side effects, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { buildEffortInjection, resolveThinkingIntensity } from '../src/effort-injection';
import { resolveModelTier } from '../src/model-routing';

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

// ─── L3: phase-detection alignment between effort-injection and model-routing ─
// resolveThinkingIntensity and resolveModelTier both derive a phase from
// (totalContinuations, evidenceStatus) using the SAME conditions (evidence
// running => validation phase; totalContinuations <= 1 => initial phase).
// They emit different output types (ThinkingIntensity vs ModelTier), so we do
// NOT share an abstraction (different semantics + model-routing has a subagent
// branch). Instead this locks the phase-detection invariant so the two cannot
// drift — a future edit to one's threshold without the other ships red.
describe('phase-detection alignment (effort-injection <-> model-routing)', () => {
  // A model-routing config whose tier names mirror the intensity names so the
  // alignment assertion reads as "same phase => same label".
  const cfg = {
    defaultTier: 'standard' as const,
    initialTurnTier: 'premium' as const,
    validationTier: 'budget' as const,
  };

  it('validation phase: evidence running triggers validationTier AND low intensity', () => {
    // Same (continuations, evidence) => both must classify as validation phase.
    const tier = resolveModelTier(0, 'running', false, cfg);
    const intensity = resolveThinkingIntensity(0, 'running', 'high');
    expect(tier).toBe('budget'); // validationTier
    expect(intensity).toBe('low'); // validation intensity
  });

  it('initial phase: totalContinuations <= 1 triggers initialTurnTier AND high intensity', () => {
    for (const c of [0, 1]) {
      const tier = resolveModelTier(c, undefined, false, cfg);
      const intensity = resolveThinkingIntensity(c, undefined, 'medium');
      expect(tier).toBe('premium'); // initialTurnTier
      expect(intensity).toBe('high'); // initial intensity
    }
  });

  it('implementation phase: totalContinuations >= 2 triggers defaultTier AND configured intensity', () => {
    const tier = resolveModelTier(5, undefined, false, cfg);
    const intensity = resolveThinkingIntensity(5, undefined, 'medium');
    expect(tier).toBe('standard'); // defaultTier
    expect(intensity).toBe('medium'); // falls through to configured (not overridden)
  });

  it('validation phase overrides initial-phase heuristic in BOTH functions', () => {
    // continuations=0 would be initial, but evidence running must win in both.
    expect(resolveModelTier(0, 'running', false, cfg)).toBe('budget');
    expect(resolveThinkingIntensity(0, 'running', 'high')).toBe('low');
  });
});
