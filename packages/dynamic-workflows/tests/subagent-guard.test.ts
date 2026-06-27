/**
 * Subagent guard integration tests for the dynamic-workflows plugin.
 *
 * The guard registers before_tool_call (priority 11) and fail-closed blocks
 * destructive ops for :subagent: sessions. These tests register the plugin
 * against a mock OpenClaw API and fire the hook directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { register, _resetForTest } from '../index';

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

  it('blocks destructive_git for a :subagent: session', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = (await h(
      { toolName: 'git', toolKind: 'destructive_git', args: ['reset', '--hard', 'HEAD~1'] },
      { sessionKey: 'agent:main:subagent:branch-1' },
    )) as { block?: boolean; blockReason?: string };
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.blockReason).toBeDefined();
  });

  it('allows read-only tools for a :subagent: session', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = await h(
      { toolName: 'Read', toolKind: 'read_only', args: [] },
      { sessionKey: 'agent:main:subagent:branch-1' },
    );
    expect(result).toBeUndefined(); // undefined = pass
  });

  it('blocks credential_access for a :subagent: session', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = (await h(
      { toolName: 'get-credential', toolKind: 'credential_access', args: [] },
      { sessionKey: 'agent:main:subagent:branch-1' },
    )) as { block?: boolean };
    expect(result.block).toBe(true);
  });

  it('allows workspace_write for a :subagent: session (subagents must still work)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = await h(
      { toolName: 'write_file', toolKind: 'workspace_write', args: [] },
      { sessionKey: 'agent:main:subagent:branch-1' },
    );
    expect(result).toBeUndefined();
  });

  it('does NOT enforce on the main session (no :subagent:)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = await h(
      { toolName: 'git', toolKind: 'destructive_git', args: ['reset', '--hard'] },
      { sessionKey: 'agent:main:main' },
    );
    expect(result).toBeUndefined();
  });

  it('respects highRiskTools config — blocks a configured tool even if read-only', async () => {
    _resetForTest();
    const m2 = createMockApi({ highRiskTools: ['dangerous_tool'] });
    register(m2.api as never);
    const h = m2.hooks.get('before_tool_call')!;
    const result = (await h(
      { toolName: 'dangerous_tool', toolKind: 'read_only', args: [] },
      { sessionKey: 'agent:main:subagent:x' },
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
