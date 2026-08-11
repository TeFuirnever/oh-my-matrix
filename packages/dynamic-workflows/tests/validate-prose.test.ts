/**
 * B6 (ticket 10): validateProse unit tests — the 5 SKILL.md Step 3 checks.
 */
import { describe, it, expect } from 'vitest';
// .mjs export — vitest resolves via the package's ESM/module config.
import { validateProse } from '../scripts/validate-prose.mjs';

const VALID = `input task: "the task"
agent worker:
  model: sonnet
let result = session: worker
  prompt: "do it"
  context: task
session "Synthesize the result"
  context: result
`;

describe('validateProse (5 checks)', () => {
  it('accepts a valid program', () => {
    expect(validateProse(VALID)).toEqual([]);
  });

  it('check 1: rejects odd indentation', () => {
    const bad = `input task: "x"
   let a = 1
`;
    const errs = validateProse(bad);
    expect(errs.some((e) => e.includes('odd indentation'))).toBe(true);
  });

  it('check 2: rejects undeclared {variable}', () => {
    const bad = `session "go"
  context: { missing }
`;
    const errs = validateProse(bad);
    expect(errs.some((e) => e.includes('missing') && e.includes('no input/let/output'))).toBe(true);
  });

  it('check 3: rejects session referencing undeclared agent', () => {
    const bad = `let r = session: ghost
  prompt: "x"
session "synth"
  context: r
`;
    const errs = validateProse(bad);
    expect(errs.some((e) => e.includes("'ghost'") && e.includes('no `agent'))).toBe(true);
  });

  it('check 4: rejects duplicate let binding', () => {
    const bad = `input task: "x"
let a = 1
let a = 2
session "s"
  context: a
`;
    const errs = validateProse(bad);
    expect(errs.some((e) => e.includes("duplicate binding 'a'"))).toBe(true);
  });

  it('check 5: rejects program ending on a worker call (no synthesis)', () => {
    const bad = `input task: "x"
agent w:
  model: sonnet
session: w
  prompt: "last is a worker call"
`;
    const errs = validateProse(bad);
    expect(errs.some((e) => e.includes('worker call') || e.includes('synthesis'))).toBe(true);
  });

  it('check 5: accepts program ending with output (block return)', () => {
    const blockEnd = `input task: "x"
output result = task
`;
    // no session, ends with output — valid (block return shape)
    expect(validateProse(blockEnd)).toEqual([]);
  });

  it('rejects empty program', () => {
    expect(validateProse('# just a comment\n\n')).toEqual(['empty program (no non-comment lines)']);
  });
});
