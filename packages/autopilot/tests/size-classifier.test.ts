/**
 * T06 (ticket 04): classifyTaskSize tests — the 4-tier deterministic classifier.
 */
import { describe, it, expect } from 'vitest';
import { classifyTaskSize } from '../src/size-classifier';

const AC_GOAL = `Refactor auth
AC-001: x
- Expected: a
AC-002: y
- Expected: b
AC-003: z
- Expected: c`;

describe('classifyTaskSize', () => {
  it('returns standard for undefined/empty goal (no downgrade on missing data)', () => {
    expect(classifyTaskSize(undefined)).toBe('standard');
    expect(classifyTaskSize('')).toBe('standard');
    expect(classifyTaskSize('   ')).toBe('standard');
  });

  it('classifies trivial (short + trivial signal + no AC)', () => {
    expect(classifyTaskSize('Fix the typo in README.md')).toBe('trivial');
    expect(classifyTaskSize('rename variable x to y')).toBe('trivial');
    expect(classifyTaskSize('fix the spelling')).toBe('trivial');
  });

  it('classifies large on large-scope signal words', () => {
    expect(classifyTaskSize('Refactor the auth module across services')).toBe('large');
    expect(classifyTaskSize('Migrate all endpoints to the new SDK')).toBe('large');
    expect(classifyTaskSize('重构整个认证模块')).toBe('large');
  });

  it('classifies large on >=3 AC criteria', () => {
    expect(classifyTaskSize(AC_GOAL)).toBe('large');
  });

  it('classifies small (short, no AC, no large signal, no trivial signal)', () => {
    expect(classifyTaskSize('fix the bug in login')).toBe('small');
  });

  it('classifies standard for medium goals without strong signals', () => {
    expect(classifyTaskSize('Add a new API endpoint with input validation and error handling plus tests')).toBe('standard');
  });

  it('does NOT downgrade a short complex goal to trivial (no trivial signal)', () => {
    // "fix the race condition" is short but complex — must stay small/standard, not trivial
    const tier = classifyTaskSize('fix the race condition');
    expect(['small', 'standard']).toContain(tier);
  });
});
