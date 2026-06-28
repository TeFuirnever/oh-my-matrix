/**
 * Subagent guard integration tests for the dynamic-workflows plugin.
 *
 * The guard registers before_tool_call (priority 11) and fail-closed blocks
 * destructive ops for :subagent: sessions. Events use the REAL OpenClaw shape
 * (verified live 2026-06-28): {toolName, params:{command?, workdir?}, runId,
 * toolCallId} — NO args / toolKind / cwd at top level. The prior tests fed a
 * fictional {toolKind:'destructive_git', args:[...]} shape the host never emits;
 * those green lies are what let the fail-open bug ship. See
 * docs/fixes/runtime-guard-event-shape.md.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { register, _resetForTest } from '../index';

// Real subagent sessionKey format (captured live 2026-06-28).
const SUBAGENT_KEY = 'agent:main:subagent:b9b3d8fc-ad1c-48d9-87de-b51db969e804';
const WS = '<test-workspace>';

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

describe('dynamic-workflows subagent guard', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as never);
  });

  it('registers before_tool_call at priority 11 (runs before autopilot 10 + audit 9)', () => {
    expect(mock.hooks.has('before_tool_call')).toBe(true);
    expect(mock.hookOpts.get('before_tool_call')?.priority).toBe(11);
  });

  it('blocks destructive git in a real exec event (the production bug)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = (await h(
      { toolName: 'exec', params: { command: 'git reset --hard HEAD~1' } },
      { sessionKey: SUBAGENT_KEY },
    )) as { block?: boolean; blockReason?: string };
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.blockReason).toBeDefined();
  });

  it('blocks destructive git chained after cd via && (real subagent shape)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = (await h(
      {
        toolName: 'exec',
        params: { command: `cd ${WS} && git reset --hard HEAD~1 2>&1`, workdir: WS },
      },
      { sessionKey: SUBAGENT_KEY },
    )) as { block?: boolean };
    expect(result.block).toBe(true);
  });

  it('allows git status chained after cd (no false positive from the && split)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = await h(
      { toolName: 'exec', params: { command: `cd ${WS} && git status 2>&1`, workdir: WS } },
      { sessionKey: SUBAGENT_KEY },
    );
    expect(result).toBeUndefined(); // undefined = pass/allow
  });

  it('defaultDeny blocks unknown shell commands for subagents (fail-closed)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = (await h(
      { toolName: 'exec', params: { command: 'totally-unknown-binary --flag' } },
      { sessionKey: SUBAGENT_KEY },
    )) as { block?: boolean };
    expect(result.block).toBe(true);
  });

  it('blocks credential_access toolName', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = (await h(
      { toolName: 'get-credential', params: {} },
      { sessionKey: SUBAGENT_KEY },
    )) as { block?: boolean };
    expect(result.block).toBe(true);
  });

  it('allows non-shell framework tools (read) for a subagent', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = await h(
      { toolName: 'read', params: { path: '/x/SKILL.md' } },
      { sessionKey: SUBAGENT_KEY },
    );
    expect(result).toBeUndefined();
  });

  it('allows sessions_spawn (workflow fan-out mechanics must not be blocked)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = await h(
      { toolName: 'sessions_spawn', params: { task: 'do x', cwd: WS } },
      { sessionKey: SUBAGENT_KEY },
    );
    expect(result).toBeUndefined();
  });

  it('blocks destructive command hidden behind & (background-operator evasion)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    // `echo harmless & git reset --hard` → shell runs echo in bg, reset --hard in fg.
    // Pre-fix SHELL_SPLIT_RE didn't split on single &, so guard saw only `echo` → allow.
    const result = (await h(
      { toolName: 'exec', params: { command: 'echo harmless & git reset --hard HEAD~1' } },
      { sessionKey: SUBAGENT_KEY },
    )) as { block?: boolean };
    expect(result.block).toBe(true);
  });

  it('does NOT enforce on the main session (no :subagent: segment)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = await h(
      { toolName: 'exec', params: { command: 'git reset --hard' } },
      { sessionKey: 'agent:main:main' },
    );
    expect(result).toBeUndefined();
  });

  it('respects highRiskTools config — blocks a configured tool even if otherwise safe', async () => {
    _resetForTest();
    const m2 = createMockApi({ highRiskTools: ['dangerous_tool'] });
    register(m2.api as never);
    const h = m2.hooks.get('before_tool_call')!;
    const result = (await h(
      { toolName: 'dangerous_tool', params: {} },
      { sessionKey: SUBAGENT_KEY },
    )) as { block?: boolean };
    expect(result.block).toBe(true);
  });

  it('does NOT register the hook when enabled=false (loud-degradation path)', () => {
    _resetForTest();
    const m2 = createMockApi({ enabled: false });
    register(m2.api as never);
    expect(m2.hooks.has('before_tool_call')).toBe(false);
  });
});
