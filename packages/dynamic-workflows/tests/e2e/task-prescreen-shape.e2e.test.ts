/**
 * E2E: the T02 task prescreen against the REAL OpenClaw agent_turn_prepare
 * event shape — {prompt, messages, queuedInjections} (PluginAgentTurnPrepareEvent,
 * hook-types). This is the same discipline as real-event-shape-guard.e2e.test.ts:
 * assert the registered hook's behavior on the host's actual contract, not a
 * fictional shape.
 *
 * Covers:
 *  1. The hook is registered on 'agent_turn_prepare' with a priority.
 *  2. A fan-out-signal prompt (real shape) returns {appendContext} — the nudge.
 *  3. Small-task prompts return undefined (no nudge, zero overhead).
 *  4. :subagent: sessionKeys are skipped (role prompts contain 'audit').
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { register, _resetForTest } from '../../index';

const MAIN_KEY = 'agent:main';
const SUBAGENT_KEY = 'agent:main:subagent:prescreen-0001';

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const hookOpts = new Map<string, { priority?: number } | undefined>();
  const api = {
    pluginConfig,
    on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => {
      hooks.set(hookName, handler);
      hookOpts.set(hookName, opts);
    },
  };
  return { api, hooks, hookOpts };
}

function realTurnPrepareEvent(prompt: string) {
  // Real PluginAgentTurnPrepareEvent shape — prompt is the raw user task.
  return { prompt, messages: [], queuedInjections: [] };
}

describe('T02 task prescreen — real event shape', () => {
  let hooks: Map<string, (...args: unknown[]) => unknown>;
  let hookOpts: Map<string, { priority?: number } | undefined>;

  beforeEach(() => {
    _resetForTest();
    const mock = createMockApi();
    register(mock.api as never);
    hooks = mock.hooks;
    hookOpts = mock.hookOpts;
  });

  it('registers agent_turn_prepare with a priority', () => {
    expect(hooks.has('agent_turn_prepare')).toBe(true);
    expect(hookOpts.get('agent_turn_prepare')?.priority).toBeTypeOf('number');
  });

  it('returns appendContext nudge for fan-out signal prompts (main session)', () => {
    const handler = hooks.get('agent_turn_prepare')!;
    const result = handler(
      realTurnPrepareEvent('Audit these 12 services in parallel, fan-out across agents'),
      { sessionKey: MAIN_KEY },
    );
    expect(result).toHaveProperty('appendContext');
    expect((result as { appendContext: string }).appendContext).toContain('dynamic-workflows');
  });

  it('returns undefined for small tasks (no nudge, zero overhead)', () => {
    const handler = hooks.get('agent_turn_prepare')!;
    const result = handler(
      realTurnPrepareEvent('Fix the typo in audit.ts line 42'),
      { sessionKey: MAIN_KEY },
    );
    expect(result).toBeUndefined();
  });

  it('skips :subagent: sessions (branch role prompts contain audit/review)', () => {
    const handler = hooks.get('agent_turn_prepare')!;
    const result = handler(
      realTurnPrepareEvent('Audit these 12 services in parallel, fan-out across agents'),
      { sessionKey: SUBAGENT_KEY },
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty prompts', () => {
    const handler = hooks.get('agent_turn_prepare')!;
    expect(handler(realTurnPrepareEvent(''), { sessionKey: MAIN_KEY })).toBeUndefined();
  });
});
