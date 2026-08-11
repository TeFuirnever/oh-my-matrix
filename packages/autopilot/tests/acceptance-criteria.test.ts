/**
 * T05 (AC-NNN predicates): parse / render / injection tests.
 * The goal string carries an embedded AC block; these pin the parsing rules
 * and the backward-compatibility contract (free-text goal → []).
 */
import { describe, it, expect } from 'vitest';
import { parseAcceptanceCriteria, renderAcceptanceCriteria, goalInjectionText } from '../src/acceptance-criteria';

const AC_GOAL = `Fix login button color

AC-001: Login button renders primary color
- Scenario: logged-out user on /login
- Action: open page
- Expected: button background is the primary token
- Must not: alter other button styles
- Verification: vitest login-button.test.ts
- Priority: required

AC-002: No layout shift
- Expected: no reflow on first paint
- Priority: important`;

describe('parseAcceptanceCriteria', () => {
  it('returns [] for a legacy free-text goal (backward compat)', () => {
    expect(parseAcceptanceCriteria('Fix the typo in README.md')).toEqual([]);
    expect(parseAcceptanceCriteria(undefined)).toEqual([]);
    expect(parseAcceptanceCriteria('')).toEqual([]);
  });

  it('parses AC-NNN blocks with headers and bullets', () => {
    const ac = parseAcceptanceCriteria(AC_GOAL);
    expect(ac).toHaveLength(2);
    expect(ac[0]).toMatchObject({
      id: 'AC-001',
      title: 'Login button renders primary color',
      scenario: 'logged-out user on /login',
      action: 'open page',
      expected: 'button background is the primary token',
      mustNot: 'alter other button styles',
      verification: 'vitest login-button.test.ts',
      priority: 'required',
    });
    expect(ac[1].priority).toBe('important');
  });

  it('ignores invalid priority values', () => {
    const goal = `AC-001: x
- Priority: maybe`;
    const ac = parseAcceptanceCriteria(goal);
    expect(ac[0].priority).toBeUndefined();
  });

  it('ignores unknown bullet fields', () => {
    const goal = `AC-001: x
- Color: red
- Expected: it works`;
    const ac = parseAcceptanceCriteria(goal);
    expect(ac[0].expected).toBe('it works');
    expect(ac[0]).not.toHaveProperty('color');
  });
});

describe('renderAcceptanceCriteria', () => {
  it('renders compact one-line-per-AC', () => {
    const ac = parseAcceptanceCriteria(AC_GOAL);
    const out = renderAcceptanceCriteria(ac);
    expect(out).toContain('AC-001 (required): button background is the primary token · verify: vitest login-button.test.ts');
    expect(out).toContain('AC-002 (important): no reflow on first paint');
  });
});

describe('goalInjectionText', () => {
  it('returns "" for empty goal', () => {
    expect(goalInjectionText(undefined)).toBe('');
    expect(goalInjectionText('')).toBe('');
  });

  it('renders free-text goal as before (backward compat)', () => {
    const out = goalInjectionText('Fix the typo in README.md');
    expect(out).toBe('[Autopilot] Current goal: Fix the typo in README.md');
    expect(out).not.toContain('Acceptance criteria');
  });

  it('renders intent + AC block for AC-driven goals', () => {
    const out = goalInjectionText(AC_GOAL);
    expect(out).toContain('[Autopilot] Current goal: Fix login button color');
    expect(out).toContain('[Autopilot] Acceptance criteria:');
    expect(out).toContain('AC-001');
    // intent does not bleed the AC header
    expect(out.split('\n')[0]).toBe('[Autopilot] Current goal: Fix login button color');
  });
});
