/**
 * Tests: model tier routing pure functions.
 * Covers resolveModelTier, resolveModelId, isSubagentSession,
 * extractParentSessionKey, parseModelRouting (camelCase + snake_case).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveModelTier,
  resolveModelId,
  isSubagentSession,
  extractParentSessionKey,
  parseModelRouting,
} from '../src/model-routing';
import type { ModelRoutingConfig } from '../src/types';

const cfg: ModelRoutingConfig = {
  defaultTier: 'standard',
  initialTurnTier: 'premium',
  validationTier: 'budget',
  subagentTier: 'budget',
  modelIds: {
    budget: 'deepseek-v4-pro',
    standard: 'claude-sonnet-4-6',
    premium: 'claude-opus-4-8',
  },
};

describe('resolveModelTier', () => {
  it('initial turns -> initialTurnTier', () => {
    expect(resolveModelTier(0, undefined, false, cfg)).toBe('premium');
    expect(resolveModelTier(1, undefined, false, cfg)).toBe('premium');
  });

  it('implementation -> defaultTier', () => {
    expect(resolveModelTier(5, undefined, false, cfg)).toBe('standard');
  });

  it('evidence running -> validationTier', () => {
    expect(resolveModelTier(5, 'running', false, cfg)).toBe('budget');
  });

  it('evidence running overrides initial-turn heuristic', () => {
    expect(resolveModelTier(0, 'running', false, cfg)).toBe('budget');
  });

  it('subagent with subagentTier -> subagentTier', () => {
    expect(resolveModelTier(5, undefined, true, cfg)).toBe('budget');
  });

  it('subagent without subagentTier falls through to phase logic', () => {
    const noSub = { ...cfg, subagentTier: undefined };
    expect(resolveModelTier(0, undefined, true, noSub)).toBe('premium');
    expect(resolveModelTier(5, undefined, true, noSub)).toBe('standard');
  });

  it('built-in defaults when no config', () => {
    expect(resolveModelTier(0, undefined, false)).toBe('premium');
    expect(resolveModelTier(5, undefined, false)).toBe('standard');
    expect(resolveModelTier(5, 'running', false)).toBe('standard');
  });

  it('non-running evidence falls through to phase logic', () => {
    expect(resolveModelTier(5, 'passed', false, cfg)).toBe('standard');
    expect(resolveModelTier(0, 'failed', false, cfg)).toBe('premium');
  });

  it('E10/P2-18: evidence failed -> repair turn uses initialTurnTier (premium)', () => {
    // The repair turn after a validation failure needs the strongest tier, not
    // defaultTier — regardless of turn count. Without this, turn 5+ failed
    // resolved to 'standard' (the most capability-demanding phase under-resourced).
    expect(resolveModelTier(5, 'failed', false, cfg)).toBe('premium');
    expect(resolveModelTier(20, 'failed', false, cfg)).toBe('premium');
  });
});

describe('resolveModelId', () => {
  it('returns model ID for configured tier', () => {
    expect(resolveModelId('premium', cfg)).toBe('claude-opus-4-8');
    expect(resolveModelId('budget', cfg)).toBe('deepseek-v4-pro');
  });

  it('undefined for unconfigured tier => inherit declared model', () => {
    expect(resolveModelId('standard', { defaultTier: 'standard' })).toBeUndefined();
  });

  it('undefined when no config', () => {
    expect(resolveModelId('premium')).toBeUndefined();
  });
});

describe('isSubagentSession', () => {
  it('detects subagent keys', () => {
    expect(isSubagentSession('agent:main:subagent:task-abc')).toBe(true);
    expect(isSubagentSession('agent:bot-1:subagent:review')).toBe(true);
  });

  it('rejects non-subagent keys', () => {
    expect(isSubagentSession('agent:main')).toBe(false);
    expect(isSubagentSession('session:abc')).toBe(false);
    expect(isSubagentSession(undefined)).toBe(false);
  });
});

describe('extractParentSessionKey', () => {
  it('extracts parent from subagent key', () => {
    expect(extractParentSessionKey('agent:main:subagent:task-abc')).toBe('agent:main');
  });

  it('undefined for non-subagent key', () => {
    expect(extractParentSessionKey('agent:main')).toBeUndefined();
    expect(extractParentSessionKey(undefined)).toBeUndefined();
  });
});

describe('parseModelRouting', () => {
  it('parses camelCase (plugin config)', () => {
    const r = parseModelRouting({
      defaultTier: 'standard',
      initialTurnTier: 'premium',
      modelIds: { premium: 'claude-opus-4-8' },
    });
    expect(r?.defaultTier).toBe('standard');
    expect(r?.initialTurnTier).toBe('premium');
    expect(r?.modelIds?.premium).toBe('claude-opus-4-8');
  });

  it('parses snake_case (WORKFLOW.md front-matter)', () => {
    const r = parseModelRouting({
      default_tier: 'budget',
      initial_turn_tier: 'premium',
      subagent_tier: 'budget',
      model_ids: { premium: 'opus' },
    });
    expect(r?.defaultTier).toBe('budget');
    expect(r?.initialTurnTier).toBe('premium');
    expect(r?.subagentTier).toBe('budget');
    expect(r?.modelIds?.premium).toBe('opus');
  });

  it('returns undefined when defaultTier absent => no routing', () => {
    expect(parseModelRouting({ initialTurnTier: 'premium' })).toBeUndefined();
    expect(parseModelRouting(undefined)).toBeUndefined();
    expect(parseModelRouting(null)).toBeUndefined();
    expect(parseModelRouting('standard')).toBeUndefined();
  });

  it('rejects invalid tier values', () => {
    expect(parseModelRouting({ defaultTier: 'super' })).toBeUndefined();
  });

  it('ignores non-string modelId entries', () => {
    const r = parseModelRouting({ defaultTier: 'standard', modelIds: { premium: 123 } });
    expect(r?.modelIds).toBeUndefined();
  });
});
