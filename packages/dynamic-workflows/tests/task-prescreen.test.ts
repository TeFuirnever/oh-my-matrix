/**
 * T02 (ticket 02): task prescreen — deterministic fan-out signal detection.
 *
 * The dynamic-workflows skill trigger is model-self-judged (probabilistic);
 * the prescreen adds a deterministic nudge at agent_turn_prepare. These tests
 * pin the signal/suppressor/size rules of isFanOutCandidate.
 */
import { describe, it, expect } from 'vitest';
import { isFanOutCandidate } from '../index';

describe('isFanOutCandidate', () => {
  it('triggers on parallel signal words', () => {
    expect(isFanOutCandidate('Audit these 12 services in parallel, fan-out across agents')).toBe(true);
    expect(isFanOutCandidate('Give me 3 independent perspectives on this design')).toBe(true);
  });

  it('triggers on multi-file / large-scope signals', () => {
    expect(isFanOutCandidate('Refactor the auth module across multiple files')).toBe(true);
    expect(isFanOutCandidate('Migrate all API endpoints to the new SDK')).toBe(true);
  });

  it('triggers on Chinese signal words', () => {
    expect(isFanOutCandidate('并行审查这 15 个文件的错误处理，交叉验证后汇总')).toBe(true);
    expect(isFanOutCandidate('对全部端点做安全审计，多视角')).toBe(true);
  });

  it('triggers on size alone for long complex prompts', () => {
    const long = 'Analyze this request: '.repeat(40); // > 400 chars
    expect(isFanOutCandidate(long)).toBe(true);
  });

  it('does NOT trigger on small tasks even with signal-adjacent words', () => {
    expect(isFanOutCandidate('Fix the typo in audit.ts line 42')).toBe(false);
    expect(isFanOutCandidate('quick fix: rename a variable in one file')).toBe(false);
    expect(isFanOutCandidate('改个拼写，一行就够')).toBe(false);
  });

  it('does NOT trigger on empty or short plain prompts', () => {
    expect(isFanOutCandidate('')).toBe(false);
    expect(isFanOutCandidate('   ')).toBe(false);
    expect(isFanOutCandidate('hi')).toBe(false);
  });
});
