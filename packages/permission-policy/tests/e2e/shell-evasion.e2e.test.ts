/**
 * E2E: Shell evasion attack vectors (B3 bash -c payload bypass)
 */
import { describe, it, expect } from 'vitest';
import { decidePermissionForEvent } from '../../src/permission-policy';

describe('B3 — bash -c payload recursion bypass', () => {
  const subagentOpts = {
    workflowAllowsDestructiveGit: false,
    defaultDeny: true as const,
    workspacePath: '/ws',
  };
  const trustedOpts = {
    workflowAllowsDestructiveGit: false,
    workspacePath: '/ws',
  };

  it('blocks bash -c "rm -rf /" in subagent (defaultDeny)', () => {
    const ev = { toolName: 'bash', params: { command: '-c rm -rf /' } };
    expect(decidePermissionForEvent(ev, subagentOpts).outcome).toBe('block');
  });

  it('blocks sh -c "git reset --hard" in subagent', () => {
    const ev = { toolName: 'sh', params: { command: '-c git reset --hard' } };
    expect(decidePermissionForEvent(ev, subagentOpts).outcome).toBe('block');
  });

  it('blocks bash -- (double-dash payload separator)', () => {
    const ev = { toolName: 'bash', params: { command: '-- rm -rf /' } };
    expect(decidePermissionForEvent(ev, subagentOpts).outcome).toBe('block');
  });

  it('allows bash -c in trusted session (no defaultDeny)', () => {
    const ev = { toolName: 'bash', params: { command: '-c echo hi' } };
    expect(decidePermissionForEvent(ev, trustedOpts).outcome).toBe('allow');
  });
});
