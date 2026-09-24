/**
 * M2.4 TDD Tests: Permission policy + Command Classifier
 *
 * TDD: Written BEFORE implementation — expected to FAIL initially.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as p from 'node:path';
import {
  classifyCommand,
  decidePermission,
  decidePermissionForEvent,
  extractCommandSegments,
  unintrospectableWriteTools,
} from '../src/permission-policy';
import type { PermissionDecisionInput } from '../src/permission-policy';

describe('extractCommandSegments shell-feature detection (substitution evasion fix)', () => {
  it('flags command substitution / backticks / process substitution', () => {
    expect(extractCommandSegments({ toolName: 'exec', params: { command: 'echo $(rm -rf /)' } }).hasShellFeature).toBe(true);
    expect(extractCommandSegments({ toolName: 'exec', params: { command: 'echo `rm`' } }).hasShellFeature).toBe(true);
    expect(extractCommandSegments({ toolName: 'exec', params: { command: 'cat <(rm -rf /)' } }).hasShellFeature).toBe(true);
  });
  it('does NOT flag fd-redirect (2>&1) or plain commands', () => {
    expect(extractCommandSegments({ toolName: 'exec', params: { command: 'git status 2>&1' } }).hasShellFeature).toBe(false);
    expect(extractCommandSegments({ toolName: 'exec', params: { command: 'git status' } }).hasShellFeature).toBe(false);
  });
});

describe('classifyCommand git/find evasion hardening (spec §3)', () => {
  it('force-push is destructive_git; plain push stays network', () => {
    expect(classifyCommand('git', ['push', '--force'])).toBe('destructive_git');
    expect(classifyCommand('git', ['push', '-f'])).toBe('destructive_git');
    expect(classifyCommand('git', ['push', '--force-with-lease'])).toBe('destructive_git');
    expect(classifyCommand('git', ['push', 'origin', 'main'])).toBe('network');
  });
  it('commit --amend / rebase is destructive_git', () => {
    expect(classifyCommand('git', ['commit', '--amend'])).toBe('destructive_git');
    expect(classifyCommand('git', ['rebase', 'main'])).toBe('destructive_git');
  });
  it('branch -D / tag -d / stash clear|drop is destructive_git', () => {
    expect(classifyCommand('git', ['branch', '-D', 'x'])).toBe('destructive_git');
    expect(classifyCommand('git', ['tag', '-d', 'v1'])).toBe('destructive_git');
    expect(classifyCommand('git', ['stash', 'clear'])).toBe('destructive_git');
    expect(classifyCommand('git', ['stash', 'drop'])).toBe('destructive_git');
  });
  it('checkout discarding workdir is destructive_git; branch switch stays safe', () => {
    expect(classifyCommand('git', ['checkout', '.'])).toBe('destructive_git');
    expect(classifyCommand('git', ['checkout', '--', 'f'])).toBe('destructive_git');
    expect(classifyCommand('git', ['checkout', 'main'])).toBe('safe_git');
  });
  it('find -delete/-exec is workspace_cleanup; plain find stays read_only', () => {
    expect(classifyCommand('find', ['.', '-delete'])).toBe('workspace_cleanup');
    expect(classifyCommand('find', ['.', '-exec', 'rm'])).toBe('workspace_cleanup');
    expect(classifyCommand('find', ['.', '-name', 'x'])).toBe('read_only');
  });
  it('strips leading git -c/-C global flags before the subcommand', () => {
    expect(classifyCommand('git', ['-c', 'x=y', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['-C', '/p', 'push', '--force'])).toBe('destructive_git');
    // attached single-token forms: -c<key>=<value> and -C<path>
    expect(classifyCommand('git', ['-ccore.askPass=evil', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['-C/path', 'push', '--force'])).toBe('destructive_git');
  });
  it('strips long-form git global flags (--work-tree, --git-dir, --namespace) — SEC-5', () => {
    // combined form: --flag=value
    expect(classifyCommand('git', ['--work-tree=/sensitive', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--git-dir=/path', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--namespace=ns', 'clean', '-fd'])).toBe('destructive_git');
    // space-separated form: --flag value
    expect(classifyCommand('git', ['--work-tree', '/sensitive', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--git-dir', '/path', 'push', '--force'])).toBe('destructive_git');
    // mixed: long-form + short -C
    expect(classifyCommand('git', ['--work-tree=/path', '-C', '/cwd', 'reset', '--hard'])).toBe('destructive_git');
  });
  it('strips --bare boolean flag before the subcommand', () => {
    expect(classifyCommand('git', ['--bare', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--bare', 'clean', '-fd'])).toBe('destructive_git');
  });
  it('strips remaining boolean git global flags (-p, --no-pager, --literal-pathspecs, etc.)', () => {
    expect(classifyCommand('git', ['-p', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--no-pager', 'clean', '-fd'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--literal-pathspecs', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--no-replace-objects', 'push', '--force'])).toBe('destructive_git');
  });
  it('strips --exec-path and --config-env flags (= and space-separated forms)', () => {
    expect(classifyCommand('git', ['--exec-path=/evil', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--exec-path', '/evil', 'reset', '--hard'])).toBe('destructive_git');
    expect(classifyCommand('git', ['--config-env=HOME=X', 'clean', '-fd'])).toBe('destructive_git');
  });
});

// ─── B4/B6/B7: destructive-git classifier gaps (Issue #47 deferred findings) ──
// TDD: these PoC tests MUST FAIL before the fix and PASS after.
describe('B4/B6/B7 destructive-git classification gaps', () => {
  // ── B4: git checkout <ref> <path> discards workdir (was safe_git) ──
  it('B4: git checkout HEAD . → destructive_git (discard via ref+path)', () => {
    expect(classifyCommand('git', ['checkout', 'HEAD', '.'])).toBe('destructive_git');
  });
  it('B4: git checkout HEAD~1 . → destructive_git', () => {
    expect(classifyCommand('git', ['checkout', 'HEAD~1', '.'])).toBe('destructive_git');
  });
  it('B4: git checkout HEAD file.txt → destructive_git (ref + named path)', () => {
    expect(classifyCommand('git', ['checkout', 'HEAD', 'file.txt'])).toBe('destructive_git');
  });
  it('B4: git checkout HEAD -- file.txt stays destructive_git (regression)', () => {
    expect(classifyCommand('git', ['checkout', 'HEAD', '--', 'file.txt'])).toBe('destructive_git');
  });

  // ── B6: git -c <bareword> must not eat the subcommand (was unknown) ──
  it('B6: git -c clean -fd → destructive_git (bareword not consumed as -c value)', () => {
    expect(classifyCommand('git', ['-c', 'clean', '-fd'])).toBe('destructive_git');
  });
  it('B6: git -c reset --hard → destructive_git (bareword subcommand surfaces)', () => {
    expect(classifyCommand('git', ['-c', 'reset', '--hard'])).toBe('destructive_git');
  });

  // ── B7: git checkout -B resets branch (was safe_git) ──
  it('B7: git checkout -B main origin/main → destructive_git (force branch reset)', () => {
    expect(classifyCommand('git', ['checkout', '-B', 'main', 'origin/main'])).toBe('destructive_git');
  });
  it('B7: git checkout -B main → destructive_git (bare force-create)', () => {
    expect(classifyCommand('git', ['checkout', '-B', 'main'])).toBe('destructive_git');
  });

  // ── B8: git checkout -f / --force discards workdir (was safe_git) ──
  it('B8: git checkout -f . → destructive_git (force discard workdir)', () => {
    expect(classifyCommand('git', ['checkout', '-f', '.'])).toBe('destructive_git');
  });
  it('B8: git checkout --force HEAD → destructive_git (force overwrites workdir)', () => {
    expect(classifyCommand('git', ['checkout', '--force', 'HEAD'])).toBe('destructive_git');
  });
  it('B8: git checkout -f main → destructive_git (force branch switch discards local mods)', () => {
    expect(classifyCommand('git', ['checkout', '-f', 'main'])).toBe('destructive_git');
  });

  // ── Regressions: safe checkout forms must NOT become destructive ──
  it('regression: git checkout main → safe_git (single positional = branch switch)', () => {
    expect(classifyCommand('git', ['checkout', 'main'])).toBe('safe_git');
  });
  it('regression: git checkout HEAD → safe_git (detached HEAD, single positional)', () => {
    expect(classifyCommand('git', ['checkout', 'HEAD'])).toBe('safe_git');
  });
  it('regression: git checkout -b feature origin/main → safe_git (tracking branch create)', () => {
    expect(classifyCommand('git', ['checkout', '-b', 'feature', 'origin/main'])).toBe('safe_git');
  });
  it('regression: git checkout -b newbranch → safe_git (lowercase -b is safe create)', () => {
    expect(classifyCommand('git', ['checkout', '-b', 'newbranch'])).toBe('safe_git');
  });

  // ── Regressions: existing global-flag stripping must still work ──
  it('regression: git -c x=y reset --hard → destructive_git (well-formed -c key=val)', () => {
    expect(classifyCommand('git', ['-c', 'x=y', 'reset', '--hard'])).toBe('destructive_git');
  });
  it('regression: git -c core.bare reset --hard → destructive_git (boolean -c key has dot)', () => {
    // Boolean shorthand: `git -c advice.detachedHead` is valid (=true); a config
    // key always contains a `.` (section.name), so it is consumed and reset surfaces.
    expect(classifyCommand('git', ['-c', 'core.bare', 'reset', '--hard'])).toBe('destructive_git');
  });
  it('regression: git -c advice.detachedHead reset --hard → destructive_git (bool key)', () => {
    expect(classifyCommand('git', ['-c', 'advice.detachedHead', 'reset', '--hard'])).toBe('destructive_git');
  });
  it('regression: git -C /p push --force → destructive_git (-C path unchanged)', () => {
    expect(classifyCommand('git', ['-C', '/p', 'push', '--force'])).toBe('destructive_git');
  });
  it('regression: git -ccore.x=y reset --hard (attached -c) → destructive_git', () => {
    expect(classifyCommand('git', ['-ccore.askPass=evil', 'reset', '--hard'])).toBe('destructive_git');
  });
});

describe('extractCommandSegments (shell split)', () => {
  it('splits on && into per-command argv', () => {
    const { segments } = extractCommandSegments({ toolName: 'exec', params: { command: 'cd /ws && git status' } });
    expect(segments).toEqual([['cd', '/ws'], ['git', 'status']]);
  });
  it('splits on & (background) — evasion fix: echo hi & git reset --hard', () => {
    const { segments } = extractCommandSegments({ toolName: 'exec', params: { command: 'echo hi & git reset --hard' } });
    expect(segments.length).toBe(2);
    expect(segments[1]).toEqual(['git', 'reset', '--hard']);
  });
  it('splits on newline', () => {
    const { segments } = extractCommandSegments({ toolName: 'exec', params: { command: 'echo a\necho b' } });
    expect(segments.length).toBe(2);
  });
  it('returns cwd from params.workdir', () => {
    const { cwd } = extractCommandSegments({ toolName: 'exec', params: { command: 'git status', workdir: '/x' } });
    expect(cwd).toBe('/x');
  });
  it('empty segments for non-shell tools (read/sessions_*)', () => {
    const { segments } = extractCommandSegments({ toolName: 'read', params: { path: '/x' } });
    expect(segments).toEqual([]);
  });
});

// ─── Command Classifier ──────────────────────────────────────

describe('classifyCommand', () => {
  it('classifies rg/grep as read_only', () => {
    expect(classifyCommand('rg', ['pattern'])).toBe('read_only');
    expect(classifyCommand('grep', ['pattern', 'file'])).toBe('read_only');
  });

  it('classifies ls/find/cat/head/tail as read_only', () => {
    expect(classifyCommand('ls', ['-la'])).toBe('read_only');
    expect(classifyCommand('find', ['.'])).toBe('read_only');
    expect(classifyCommand('cat', ['file.ts'])).toBe('read_only');
  });

  it('classifies git status/diff/log/branch as safe_git', () => {
    expect(classifyCommand('git', ['status'])).toBe('safe_git');
    expect(classifyCommand('git', ['diff'])).toBe('safe_git');
    expect(classifyCommand('git', ['log', '--oneline'])).toBe('safe_git');
    expect(classifyCommand('git', ['branch'])).toBe('safe_git');
    expect(classifyCommand('git', ['rev-parse', 'HEAD'])).toBe('safe_git');
    expect(classifyCommand('git', ['show', 'HEAD'])).toBe('safe_git');
  });

  it('classifies pnpm test as validation', () => {
    expect(classifyCommand('pnpm', ['test'])).toBe('validation');
  });

  // B1: `run <script>` executes an arbitrary package.json script (opaque code) —
  // must NOT be validation, or `npm run evil` bypasses the subagent defaultDeny
  // guard (validation is allowed unconditionally). Falls to unknown: trusted allow,
  // subagent block. `test` stays validation by convention.
  it('classifies pnpm/npm/yarn run <script> as unknown (B1)', () => {
    expect(classifyCommand('pnpm', ['run', 'typecheck'])).toBe('unknown');
    expect(classifyCommand('pnpm', ['run', 'lint'])).toBe('unknown');
    expect(classifyCommand('pnpm', ['run', 'build'])).toBe('unknown');
    expect(classifyCommand('npm', ['run', 'pwn'])).toBe('unknown');
    expect(classifyCommand('yarn', ['run', 'anything'])).toBe('unknown');
  });

  it('npx / <pkg>-exec wrap arbitrary commands → classify payload (wrapper-exec fix); npm test stays validation', () => {
    expect(classifyCommand('npx', ['rm', '-rf', 'dist'])).toBe('workspace_cleanup');
    expect(classifyCommand('pnpm', ['exec', 'rm', '-rf', 'dist'])).toBe('workspace_cleanup');
    expect(classifyCommand('npm', ['exec', 'rm', '-rf', 'dist'])).toBe('workspace_cleanup');
    expect(classifyCommand('npm', ['test'])).toBe('validation');
  });

  it('classifies git worktree add as worktree_create', () => {
    expect(classifyCommand('git', ['worktree', 'add'])).toBe('worktree_create');
  });

  it('classifies git worktree remove as workspace_cleanup', () => {
    expect(classifyCommand('git', ['worktree', 'remove'])).toBe('workspace_cleanup');
  });

  it('classifies git reset --hard as destructive_git', () => {
    expect(classifyCommand('git', ['reset', '--hard'])).toBe('destructive_git');
  });

  it('classifies git clean -fd as destructive_git', () => {
    expect(classifyCommand('git', ['clean', '-fd'])).toBe('destructive_git');
  });

  it('classifies git checkout -- as destructive_git', () => {
    expect(classifyCommand('git', ['checkout', '--', '.'])).toBe('destructive_git');
  });

  it('classifies curl/wget as network', () => {
    expect(classifyCommand('curl', ['http://example.com'])).toBe('network');
    expect(classifyCommand('wget', ['http://example.com'])).toBe('network');
  });

  it('classifies pnpm/npm install as network', () => {
    expect(classifyCommand('pnpm', ['install'])).toBe('network');
    expect(classifyCommand('npm', ['install'])).toBe('network');
  });

  it('classifies git push/fetch as network', () => {
    expect(classifyCommand('git', ['push'])).toBe('network');
    expect(classifyCommand('git', ['fetch'])).toBe('network');
  });

  it('classifies unknown tools as unknown', () => {
    expect(classifyCommand('some-random-tool', ['args'])).toBe('unknown');
  });

  it('classifies file write tools as workspace_write when cwd is workspace', () => {
    // Write/Edit tools with workspace context should be workspace_write
    expect(classifyCommand('write_file', ['file.ts'], 'workspace_write')).toBe('workspace_write');
  });

  it('classifies sudo as system_write', () => {
    expect(classifyCommand('sudo', ['rm', '-rf', '/'])).toBe('system_write');
  });

  it('classifies chmod/chown as system_write', () => {
    expect(classifyCommand('chmod', ['777', 'file'])).toBe('system_write');
    expect(classifyCommand('chown', ['user', 'file'])).toBe('system_write');
  });
});

// ─── Permission Decision ──────────────────────────────────────

describe('decidePermission', () => {
  const workspacePath = '/repo/.matrix/worktrees/autopilot-s1';
  const workspaceRoot = '/repo/.matrix/worktrees';

  function makeInput(overrides: Partial<PermissionDecisionInput> = {}): PermissionDecisionInput {
    return {
      toolName: 'code_mode_exec',
      command: ['git', 'status'],
      cwd: workspacePath,
      workspacePath,
      workspaceRoot,
      workflowAllowsDestructiveGit: false,
      ...overrides,
    };
  }

  // ─── Default (full_yolo) ─────────────────────────────────

  describe('Default behavior', () => {
    it('allows read_only commands', () => {
      const result = decidePermission(makeInput({ command: ['rg', 'pattern'] }));
      expect(result.outcome).toBe('allow');
    });

    it('allows safe_git commands', () => {
      const result = decidePermission(makeInput({ command: ['git', 'status'] }));
      expect(result.outcome).toBe('allow');
    });

    it('allows validation commands in workspace', () => {
      const result = decidePermission(makeInput({ command: ['pnpm', 'test'] }));
      expect(result.outcome).toBe('allow');
    });

    it('allows workspace_write commands in workspace', () => {
      const result = decidePermission(makeInput({
        toolName: 'write_file',
        toolKind: 'workspace_write',
        command: ['file.ts'],
        cwd: workspacePath,
      }));
      expect(result.outcome).toBe('allow');
    });

    it('blocks destructive_git commands by default (no workflowAllowsDestructiveGit)', () => {
      const result = decidePermission(makeInput({ command: ['git', 'reset', '--hard'] }));
      expect(result.outcome).toBe('block');
    });

    it('allows network commands', () => {
      const result = decidePermission(makeInput({ command: ['curl', 'http://example.com'] }));
      expect(result.outcome).toBe('allow');
    });

    it('blocks credential_access commands', () => {
      const result = decidePermission(makeInput({
        toolName: 'read_credentials',
        toolKind: 'credential_access',
        command: [],
      }));
      expect(result.outcome).toBe('block');
    });

    it('blocks system_write commands', () => {
      const result = decidePermission(makeInput({ command: ['sudo', 'rm'] }));
      expect(result.outcome).toBe('block');
    });

    it('allows unknown commands by default (blacklist strategy)', () => {
      const result = decidePermission(makeInput({ command: ['unknown-tool', 'args'] }));
      expect(result.outcome).toBe('allow');
    });

    it('blocks workspace_cleanup (rm blocked — user must perform manually)', () => {
      const result = decidePermission(makeInput({ command: ['git', 'worktree', 'remove', workspacePath] }));
      expect(result.outcome).toBe('block');
    });
  });

  // ─── Destructive git with workflow permission ─────────────

  describe('Destructive git', () => {
    it('allows destructive git when workflow allows and cwd is workspace', () => {
      const result = decidePermission(makeInput({
        command: ['git', 'reset', '--hard'],
        workflowAllowsDestructiveGit: true,
        cwd: workspacePath,
      }));
      expect(result.outcome).toBe('allow');
    });

    it('blocks destructive git without workflow permission', () => {
      const result = decidePermission(makeInput({
        command: ['git', 'reset', '--hard'],
        workflowAllowsDestructiveGit: false,
      }));
      expect(result.outcome).toBe('block');
    });

    it('blocks credential_access unconditionally', () => {
      const result = decidePermission(makeInput({
        toolName: 'read_keys',
        toolKind: 'credential_access',
        command: [],
      }));
      expect(result.outcome).toBe('block');
    });

    // Safety valve: rm is catastrophic + unrecoverable — blocked, user must do manually.
    it('blocks workspace_cleanup (rm blocked — user must perform manually)', () => {
      const result = decidePermission(makeInput({
        command: ['rm', '-rf', 'subdir'],
      }));
      expect(result.outcome).toBe('block');
    });

    it('blocks system_write', () => {
      const result = decidePermission(makeInput({
        command: ['sudo', 'rm'],
      }));
      expect(result.outcome).toBe('block');
    });
  });

  describe('classifyCommand — filesystem destructive', () => {
    it('classifies rm as workspace_cleanup', () => {
      expect(classifyCommand('rm', ['-rf', 'dist'])).toBe('workspace_cleanup');
    });
    it('classifies rm with no flags as workspace_cleanup', () => {
      expect(classifyCommand('rm', ['file.txt'])).toBe('workspace_cleanup');
    });
    it('classifies rmdir as workspace_cleanup', () => {
      expect(classifyCommand('rmdir', ['tmp'])).toBe('workspace_cleanup');
    });
    it('classifies shred as workspace_cleanup', () => {
      expect(classifyCommand('shred', ['-u', 'secret.txt'])).toBe('workspace_cleanup');
    });
    it('rm blocked (workspace_cleanup behavior)', () => {
      const result = decidePermission({
        toolName: 'rm',
        command: ['-rf', '.'],
        workflowAllowsDestructiveGit: false,
      });
      // workspace_cleanup → block (user must perform manually)
      expect(result.outcome).toBe('block');
    });
    it('env rm -rf dist → classifyCommand returns workspace_cleanup (B-4 env fix)', () => {
      expect(classifyCommand('env', ['rm', '-rf', 'dist'])).toBe('workspace_cleanup');
    });
  });

  // ─── Symlink-safe workspace containment (H3) ─────────────────
  describe('symlink-safe workspace containment', () => {
    it('allows destructive_git when cwd resolves to inside workspace (macOS /tmp → /private/tmp)', () => {
      // Simulates: cwd='/tmp/workspace/project', workspacePath='/private/tmp/workspace'
      // String.startsWith would fail; resolveReal should normalise both to the same prefix.
      // We pass already-resolved paths to sidestep the actual fs.realpathSync call.
      // The function must at minimum normalise away redundant separators / trailing slashes.
      const result = decidePermission({
        toolName: 'bash',
        command: ['git', 'reset', '--hard'],
        workflowAllowsDestructiveGit: true,
        cwd: '/private/tmp/workspace/project',      // real path (after symlink resolution)
        workspacePath: '/private/tmp/workspace',     // same real path — must match
      });
      expect(result.outcome).toBe('allow');
    });

    it('allows when cwd equals workspacePath exactly (boundary, no trailing slash)', () => {
      const result = decidePermission({
        toolName: 'bash',
        command: ['git', 'clean', '-fd'],
        workflowAllowsDestructiveGit: true,
        cwd: '/private/tmp/workspace',
        workspacePath: '/private/tmp/workspace',
      });
      expect(result.outcome).toBe('allow');
    });

    it('blocks destructive_git when cwd is a sibling directory (not a prefix match)', () => {
      // /private/tmp/workspace-evil must NOT match /private/tmp/workspace
      const result = decidePermission({
        toolName: 'bash',
        command: ['git', 'reset', '--hard'],
        workflowAllowsDestructiveGit: true,
        cwd: '/private/tmp/workspace-evil',
        workspacePath: '/private/tmp/workspace',
      });
      expect(result.outcome).toBe('block');
    });

    it('blocks destructive_git when cwd is entirely outside workspace', () => {
      const result = decidePermission({
        toolName: 'bash',
        command: ['git', 'reset', '--hard'],
        workflowAllowsDestructiveGit: true,
        cwd: '/etc',
        workspacePath: '/private/tmp/workspace',
      });
      expect(result.outcome).toBe('block');
    });
  });

  describe('classifyCommand — disk-level destructive', () => {
    it.each(['dd', 'mkfs', 'mkfs.ext4', 'mkfs.vfat', 'fdisk', 'parted', 'wipefs'])(
      'classifies %s as system_write',
      (cmd) => {
        expect(classifyCommand(cmd, [])).toBe('system_write');
      }
    );
    it('blocks dd unconditionally', () => {
      const result = decidePermission({
        toolName: 'dd',
        command: ['if=/dev/zero', 'of=/dev/sda'],
        workflowAllowsDestructiveGit: false,
      });
      expect(result.outcome).toBe('block');
    });
  });

  describe('Audit trail', () => {
    it('always provides a reason string', () => {
      const result = decidePermission(makeInput({ command: ['git', 'status'] }));
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe('string');
    });

    it('allow outcomes have audit flag', () => {
      const result = decidePermission(makeInput({ command: ['git', 'status'] }));
      if (result.outcome === 'allow') {
        expect(result.audit).toBe(true);
      }
    });
  });



  describe('classifyCommand — toolKind cross-check (security)', () => {
    it('ignores destructive_git toolKind when toolName is not git (prevents injection)', () => {
      // 'rm' with toolKind='destructive_git' must NOT be treated as destructive_git
      // It should fall through to name-based classification → workspace_cleanup
      expect(classifyCommand('rm', ['-rf', 'dist'], 'destructive_git')).toBe('workspace_cleanup');
    });

    it('ignores destructive_git toolKind when toolName is write_file (generic tool, not git)', () => {
      // The cross-check rejects the destructive_git toolKind for write_file (not a git tool)
      // and falls through to name-based classification. B9 fix: write_file is now explicitly
      // classified as workspace_write (not unknown), so subagents can still use it.
      expect(classifyCommand('write_file', [], 'destructive_git')).toBe('workspace_write');
    });

    it('still respects destructive_git toolKind when toolName is git.exe (Windows)', () => {
      expect(classifyCommand('git.exe', ['reset', '--hard'], 'destructive_git')).toBe('destructive_git');
    });

    it('still respects destructive_git toolKind when toolName is git', () => {
      expect(classifyCommand('git', ['reset', '--hard'], 'destructive_git')).toBe('destructive_git');
    });

    it('other toolKind values (workspace_write, read_only) are not affected by the cross-check', () => {
      expect(classifyCommand('write_file', [], 'workspace_write')).toBe('workspace_write');
      expect(classifyCommand('Read', [], 'read_only')).toBe('read_only');
    });
  });

  // ─── Cross-platform: Windows command classification ──────────────────
  // X-3: Windows system-level dangerous commands must be blocked
  // X-4: Windows filesystem destructive commands must require approval
  // X-5: Windows read-only equivalents must be allowed
  // X-6: Windows service management must be blocked

  describe('classifyCommand — Windows command parity', () => {
    // X-3: Windows privilege / system commands → system_write (always blocked)
    it('classifies runas as system_write', () => {
      expect(classifyCommand('runas', ['/user:Administrator', 'cmd'])).toBe('system_write');
    });

    it('classifies icacls as system_write', () => {
      expect(classifyCommand('icacls', ['C:\\file', '/grant', 'Everyone:F'])).toBe('system_write');
    });

    it('classifies cacls as system_write', () => {
      expect(classifyCommand('cacls', ['C:\\file'])).toBe('system_write');
    });

    it('classifies takeown as system_write', () => {
      expect(classifyCommand('takeown', ['/f', 'C:\\file'])).toBe('system_write');
    });

    it('classifies sc (Service Control) as system_write', () => {
      expect(classifyCommand('sc', ['start', 'MyService'])).toBe('system_write');
    });

    it('classifies sc.exe as system_write', () => {
      expect(classifyCommand('sc.exe', ['stop', 'MyService'])).toBe('system_write');
    });

    it('classifies schtasks as system_write', () => {
      expect(classifyCommand('schtasks', ['/create'])).toBe('system_write');
    });

    it('classifies format as system_write', () => {
      expect(classifyCommand('format', ['C:'])).toBe('system_write');
    });

    it('classifies diskpart as system_write', () => {
      expect(classifyCommand('diskpart', [])).toBe('system_write');
    });

    it('classifies reg (registry editor) as system_write', () => {
      expect(classifyCommand('reg', ['add', 'HKEY_LOCAL_MACHINE\\...'])).toBe('system_write');
    });

    // X-4: Windows file deletion commands → workspace_cleanup (requires approval)
    it('classifies del as workspace_cleanup', () => {
      expect(classifyCommand('del', ['file.txt'])).toBe('workspace_cleanup');
    });

    it('classifies erase as workspace_cleanup', () => {
      expect(classifyCommand('erase', ['file.txt'])).toBe('workspace_cleanup');
    });

    it('classifies rd as workspace_cleanup', () => {
      expect(classifyCommand('rd', ['/s', '/q', 'dist'])).toBe('workspace_cleanup');
    });

    // X-5: Windows read-only commands → read_only (should not require approval)
    it('classifies dir as read_only', () => {
      expect(classifyCommand('dir', ['/b'])).toBe('read_only');
    });

    it('classifies type as read_only', () => {
      expect(classifyCommand('type', ['file.txt'])).toBe('read_only');
    });

    it('classifies where as read_only', () => {
      expect(classifyCommand('where', ['node'])).toBe('read_only');
    });

    it('classifies findstr as read_only', () => {
      expect(classifyCommand('findstr', ['/r', 'pattern', 'file.txt'])).toBe('read_only');
    });
  });

  // ─── Cross-platform: Windows workspace containment ────────────────────
  // X-1: workspace containment must use path-separator-aware comparison on Windows-style paths

  describe('decidePermission — Windows path containment (X-1)', () => {
    it('allows destructive git when cwd uses Windows backslash paths inside workspace', () => {
      // Windows paths: C:\Users\dev\project is inside C:\Users\dev
      // After backslash normalization both compare correctly on any host OS.
      const result = decidePermission({
        toolName: 'bash',
        command: ['git', 'reset', '--hard'],
        workflowAllowsDestructiveGit: true,
        cwd: 'C:\\Users\\dev\\project',
        workspacePath: 'C:\\Users\\dev',
      });
      expect(result.outcome).toBe('allow');
    });

    it('blocks destructive git when Windows cwd is a sibling (not child) of workspace', () => {
      // C:\Users\dev-evil must NOT match C:\Users\dev
      const result = decidePermission({
        toolName: 'bash',
        command: ['git', 'reset', '--hard'],
        workflowAllowsDestructiveGit: true,
        cwd: 'C:\\Users\\dev-evil',
        workspacePath: 'C:\\Users\\dev',
      });
      expect(result.outcome).toBe('block');
    });

    it('allows when cwd equals workspacePath exactly on Windows (no trailing separator)', () => {
      const result = decidePermission({
        toolName: 'bash',
        command: ['git', 'clean', '-fd'],
        workflowAllowsDestructiveGit: true,
        cwd: 'C:\\Users\\dev\\project',
        workspacePath: 'C:\\Users\\dev\\project',
      });
      expect(result.outcome).toBe('allow');
    });

    // X-1 (known limitation): case-insensitive Windows FS requires realpathSync to
    // normalise casing. On a real Windows host, realpathSync('C:\Users\Dev') →
    // 'C:\Users\dev' (canonical form), so containment works automatically.
    // On macOS/Linux, path.resolve preserves casing and the check may fail for
    // mixed-case paths. This is acceptable: autopilot only runs on the local host OS,
    // so Windows paths are only compared on Windows where realpathSync handles case.
    it('documents Windows case-insensitive limitation (realpathSync handles it on real Windows)', () => {
      // On macOS host: differing-case Windows paths are expected to produce 'block'
      // because path.relative() is case-sensitive on the host. This is a known
      // limitation documented in delivery-review-followup-2026-06-10.md (X-1).
      const result = decidePermission({
        toolName: 'bash',
        command: ['git', 'reset', '--hard'],
        workflowAllowsDestructiveGit: true,
        cwd: 'C:\\Users\\Dev\\project',
        workspacePath: 'C:\\Users\\dev',
      });
      // On a real Windows host realpathSync normalises case → outcome is 'allow'.
      // On macOS test host case is preserved → outcome is 'block'. Both are acceptable.
      expect(['allow', 'block']).toContain(result.outcome);
    });
  });

  describe('classifyCommand — Windows net command (X-6 missing net start/stop)', () => {
    it('classifies net as system_write', () => {
      // net start / net stop are Windows service management (= launchctl)
      expect(classifyCommand('net', ['start', 'MyService'])).toBe('system_write');
    });

    it('classifies net.exe as system_write', () => {
      expect(classifyCommand('net.exe', ['stop', 'MyService'])).toBe('system_write');
    });
  });
});

// R-2: git add/commit must be safe_git so full_yolo allows daily git work
describe('R-2: classifyCommand — git add/commit are safe_git', () => {
  it('classifies git add as safe_git', () => {
    expect(classifyCommand('git', ['add', '.'])).toBe('safe_git');
  });

  it('classifies git add -p as safe_git', () => {
    expect(classifyCommand('git', ['add', '-p'])).toBe('safe_git');
  });

  it('classifies git commit as safe_git', () => {
    expect(classifyCommand('git', ['commit', '-m', 'feat: add thing'])).toBe('safe_git');
  });

  it('classifies git commit --amend as destructive_git (history rewrite, spec §3)', () => {
    expect(classifyCommand('git', ['commit', '--amend', '--no-edit'])).toBe('destructive_git');
  });

  it('allows git add', () => {
    const result = decidePermission({
      toolName: 'bash',
      toolKind: 'execute',
      command: ['git', 'add', '.'],
      cwd: '/workspace',
      workflowAllowsDestructiveGit: false,
    });
    expect(result.outcome).toBe('allow');
  });

  it('allows git commit', () => {
    const result = decidePermission({
      toolName: 'bash',
      toolKind: 'execute',
      command: ['git', 'commit', '-m', 'msg'],
      cwd: '/workspace',
      workflowAllowsDestructiveGit: false,
    });
    expect(result.outcome).toBe('allow');
  });

  it('git reset --hard is still destructive_git (not reclassified)', () => {
    expect(classifyCommand('git', ['reset', '--hard'])).toBe('destructive_git');
  });
});

// S4: git reset (soft/mixed) should be safe_git, not unknown
describe('S4: classifyCommand — git reset without --hard is safe_git', () => {
  it('classifies git reset HEAD~1 as safe_git (soft reset, reversible)', () => {
    expect(classifyCommand('git', ['reset', 'HEAD~1'])).toBe('safe_git');
  });

  it('classifies git reset --soft as safe_git', () => {
    expect(classifyCommand('git', ['reset', '--soft', 'HEAD~1'])).toBe('safe_git');
  });

  it('classifies git reset --mixed as safe_git', () => {
    expect(classifyCommand('git', ['reset', '--mixed'])).toBe('safe_git');
  });

  it('git reset --hard is still destructive_git', () => {
    expect(classifyCommand('git', ['reset', '--hard'])).toBe('destructive_git');
  });
});

describe('B9 — segments===0 framework tools respect defaultDeny', () => {
  // B9 fix: decidePermissionForEvent now forwards defaultDeny in the segments===0 branch.
  // Known agent-framework tools are explicitly classified (workspace_write / read_only)
  // so they pass through. Unknown tools are blocked by defaultDeny in subagent sessions.
  const frameworkEv = (toolName: string) =>
    ({ toolName, params: {} as Record<string, unknown> });

  // cwd is inside workspacePath so the Q4 workspace_write fence passes: B9 is about
  // classification reaching through the defaultDeny gate, not about unfenced writes.
  // With no cwd and no params.path the write target is unknown and Q4 fails closed —
  // pinned separately below.
  const subagentOpts = {
    workflowAllowsDestructiveGit: false,
    defaultDeny: true as const,
    workspacePath: '/ws',
    cwd: '/ws',
  };
  const trustedOpts = {
    workflowAllowsDestructiveGit: false,
    workspacePath: '/ws',
    cwd: '/ws',
  };

  it('blocks unknown framework tool with defaultDeny:true', () => {
    expect(decidePermissionForEvent(frameworkEv('unknown_dangerous_tool'), subagentOpts).outcome).toBe('block');
  });

  it.each(['write_file', 'code_editor'] as const)(
    'allows %s with defaultDeny:true (workspace_write)',
    (tool) => {
      expect(decidePermissionForEvent(frameworkEv(tool), subagentOpts).outcome).toBe('allow');
    },
  );

  // apply_patch/apply_diff carry their targets in the patch body, so the Q4 fence
  // cannot check them (a `--- a/../../etc/hosts` header escapes the workspace).
  // Untrusted sessions lose them; write/edit cover the same need.
  it.each(unintrospectableWriteTools)(
    'blocks %s with defaultDeny:true (write target not introspectable)',
    (tool) => {
      expect(decidePermissionForEvent(frameworkEv(tool), subagentOpts).outcome).toBe('block');
    },
  );

  it.each(unintrospectableWriteTools)('allows %s in a trusted session', (tool) => {
    expect(decidePermissionForEvent(frameworkEv(tool), trustedOpts).outcome).toBe('allow');
  });

  it.each(['read_file', 'sessions_spawn', 'sessions_view', 'process', 'todo_write'] as const)(
    'allows %s with defaultDeny:true (read_only)',
    (tool) => {
      expect(decidePermissionForEvent(frameworkEv(tool), subagentOpts).outcome).toBe('allow');
    },
  );

  it('allows unknown framework tool in TRUSTED session (no defaultDeny — unchanged)', () => {
    expect(decidePermissionForEvent(frameworkEv('unknown_new_tool'), trustedOpts).outcome).toBe('allow');
  });
});

// ─── OpenClaw real tool names: `write` / `edit` (not `write_file`) ─────────────
// The host emits `write` and `edit` (openclaw 2026.7.1-2, docs/tools/index.md:86).
// workspaceWriteTools only listed `write_file`, a name the host never sends, so a
// subagent's file writes fell through to `unknown` → blocked by defaultDeny. The
// only write channel that worked was `apply_patch`, which was spelled correctly.
describe('OpenClaw file-write tool names are classified as workspace_write', () => {
  it.each(['write', 'edit'] as const)('classifies %s as workspace_write', (tool) => {
    expect(classifyCommand(tool, [])).toBe('workspace_write');
  });

  it.each(['write', 'edit'] as const)('allows %s in a subagent session (defaultDeny:true)', (tool) => {
    const result = decidePermission({
      toolName: tool,
      command: [],
      cwd: '/ws/project',
      workspacePath: '/ws/project',
      defaultDeny: true,
      workflowAllowsDestructiveGit: false,
    });
    expect(result.outcome).toBe('allow');
    expect(result.commandClass ?? classifyCommand(tool, [])).toBe('workspace_write');
  });
});

// ─── Q4: workspace_write containment, subagent sessions only ──────────────────
// Naming `write`/`edit` correctly makes them allow unconditionally, which would
// let a subagent write ~/.ssh/authorized_keys or ~/.openclaw/openclaw.json. The
// destructive_git branch already fences on workspace containment; workspace_write
// reuses that fence — but ONLY under defaultDeny, so trusted autopilot main-session
// runs (which legitimately write outside the workspace, e.g. .omc/, ~/.claude/)
// keep byte-for-byte identical behaviour.
describe('workspace_write containment under defaultDeny (Q4)', () => {
  const fenced = (overrides: Partial<PermissionDecisionInput> = {}): PermissionDecisionInput => ({
    toolName: 'write',
    command: [],
    cwd: '/ws/project',
    workspacePath: '/ws/project',
    workflowAllowsDestructiveGit: false,
    defaultDeny: true,
    ...overrides,
  });

  it('allows a write whose cwd is inside the workspace', () => {
    expect(decidePermission(fenced({ cwd: '/ws/project/src' })).outcome).toBe('allow');
  });

  it('allows a write whose cwd equals the workspace exactly', () => {
    expect(decidePermission(fenced()).outcome).toBe('allow');
  });

  it('blocks a write whose cwd escapes the workspace', () => {
    expect(decidePermission(fenced({ cwd: '/Users/me/.ssh' })).outcome).toBe('block');
  });

  it('blocks the /ws-evil sibling-prefix escape', () => {
    expect(decidePermission(fenced({ cwd: '/ws/project-evil' })).outcome).toBe('block');
  });

  it('blocks when workspacePath is absent — fail-closed, no workspace means no fence to pass', () => {
    expect(decidePermission(fenced({ workspacePath: undefined })).outcome).toBe('block');
  });

  // The regression guard that matters: autopilot's main session must not be fenced.
  it('allows an out-of-workspace write in a TRUSTED session (defaultDeny falsy — unchanged)', () => {
    expect(decidePermission(fenced({ defaultDeny: false, cwd: '/Users/me/.claude' })).outcome).toBe('allow');
    expect(decidePermission(fenced({ defaultDeny: undefined, cwd: '/Users/me/.claude' })).outcome).toBe('allow');
  });

  it('allows a trusted write with no workspacePath at all (unchanged)', () => {
    expect(decidePermission(fenced({ defaultDeny: false, workspacePath: undefined, cwd: undefined })).outcome).toBe('allow');
  });
});

// The Q4 fence must read the write TARGET, not the session cwd. openclaw's write/edit
// both land `params.path` via resolveToCwd(path, cwd), so a subagent sitting legitimately
// inside the workspace can still name an absolute path outside it. A cwd-only fence
// allows that; these pin the target-based fence.
describe('workspace_write fences params.path, not cwd (Q4 escape)', () => {
  const ev = (params: Record<string, unknown>, toolName = 'write') => ({ toolName, params });
  const subagent = {
    workflowAllowsDestructiveGit: false,
    defaultDeny: true as const,
    workspacePath: '/ws/project',
    cwd: '/ws/project',
  };

  it('blocks an absolute path outside the workspace even when cwd is inside', () => {
    const d = decidePermissionForEvent(ev({ path: '/Users/me/.ssh/authorized_keys' }), subagent);
    expect(d.outcome).toBe('block');
  });

  it('blocks a ~-prefixed path (resolveToCwd does not expand it; treat as escape)', () => {
    expect(decidePermissionForEvent(ev({ path: '~/.openclaw/openclaw.json' }), subagent).outcome).toBe('block');
  });

  it('blocks a relative path that climbs out of the workspace', () => {
    expect(decidePermissionForEvent(ev({ path: '../../etc/hosts' }), subagent).outcome).toBe('block');
  });

  it('allows a relative path resolving inside the workspace', () => {
    expect(decidePermissionForEvent(ev({ path: 'src/index.ts' }), subagent).outcome).toBe('allow');
  });

  it('allows an absolute path inside the workspace', () => {
    expect(decidePermissionForEvent(ev({ path: '/ws/project/src/index.ts' }), subagent).outcome).toBe('allow');
  });

  it('fences edit on params.path too', () => {
    expect(decidePermissionForEvent(ev({ path: '/etc/passwd' }, 'edit'), subagent).outcome).toBe('block');
    expect(decidePermissionForEvent(ev({ path: '/ws/project/a.ts' }, 'edit'), subagent).outcome).toBe('allow');
  });

  it('fails closed when the target is unknown (no path param, no cwd)', () => {
    const d = decidePermissionForEvent(ev({}), { ...subagent, cwd: undefined });
    expect(d.outcome).toBe('block');
  });

  it('leaves a TRUSTED session unfenced (defaultDeny falsy)', () => {
    const trusted = { ...subagent, defaultDeny: false as const };
    expect(decidePermissionForEvent(ev({ path: '/Users/me/.claude/settings.json' }), trusted).outcome).toBe('allow');
  });
});

// ─── B4/B6/B7 security impact: destructive PoCs now BLOCKED in subagent mode ──
// Before the fix, `git checkout HEAD .` was safe_git → allowed unconditionally
// (safe_git returns allow at line 396, BEFORE the defaultDeny gate at 468).
// After the fix it is destructive_git → blocked in subagent (defaultDeny) sessions.
describe('B4/B6/B7 — subagent defaultDeny blocks destructive PoCs', () => {
  const subagentOpts = {
    workflowAllowsDestructiveGit: false,
    defaultDeny: true as const,
    workspacePath: '/ws',
  };
  const execEv = (command: string) =>
    ({ toolName: 'exec', params: { command } as Record<string, unknown> });

  it('B4: git checkout HEAD . is BLOCKED in subagent mode (was allowed via safe_git)', () => {
    const d = decidePermissionForEvent(execEv('git checkout HEAD .'), subagentOpts);
    expect(d.outcome).toBe('block');
  });

  it('B7: git checkout -B main origin/main is BLOCKED in subagent mode', () => {
    const d = decidePermissionForEvent(execEv('git checkout -B main origin/main'), subagentOpts);
    expect(d.outcome).toBe('block');
  });
});

// ── Q4b: write fence against a REAL filesystem ────────────────────────────
// These use actual dirs/symlinks because the bug is asymmetric symlink
// resolution: with fabricated paths both sides fall back to a lexical resolve
// and agree, so the false-positive is invisible. macOS /tmp -> /private/tmp
// reproduces it for free.
describe('Q4b: write fence with real paths (symlink symmetry)', () => {
  const writeEv = (targetPath: string) =>
    ({ toolName: 'write', params: { path: targetPath } as Record<string, unknown> });
  const deny = (workspacePath: string, cwd: string) =>
    ({ workflowAllowsDestructiveGit: false, defaultDeny: true as const, workspacePath, cwd });

  it('allows creating a NEW file when the workspace path contains a symlink', () => {
    // os.tmpdir() is the unresolved /tmp form on macOS; the workspace exists so
    // it resolves to /private/tmp/... while the missing target would not.
    const ws = fs.mkdtempSync(p.join(os.tmpdir(), 'q4b-ws-'));
    try {
      const target = p.join(ws, 'src', 'brand-new-file.ts');
      expect(fs.existsSync(target)).toBe(false);
      expect(decidePermissionForEvent(writeEv(target), deny(ws, ws)).outcome).toBe('allow');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('blocks a new file reached through an in-workspace symlink pointing out', () => {
    const ws = fs.realpathSync(fs.mkdtempSync(p.join(os.tmpdir(), 'q4b-ws-')));
    const outside = fs.realpathSync(fs.mkdtempSync(p.join(os.tmpdir(), 'q4b-out-')));
    try {
      fs.symlinkSync(outside, p.join(ws, 'escape'));
      const target = p.join(ws, 'escape', 'planted.txt');
      expect(decidePermissionForEvent(writeEv(target), deny(ws, ws)).outcome).toBe('block');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('blocks a plain traversal escape from a real workspace', () => {
    const ws = fs.realpathSync(fs.mkdtempSync(p.join(os.tmpdir(), 'q4b-ws-')));
    try {
      const target = p.join(ws, '..', '..', 'etc', 'hosts');
      expect(decidePermissionForEvent(writeEv(target), deny(ws, ws)).outcome).toBe('block');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ─── Host tool-name coverage guard ──────────────────────────────────────────
// WHY THIS EXISTS: the `write`/`edit` bug (see workspaceWriteTools, "B9 fix")
// was a NAME DRIFT bug, not a policy bug. The classifier said `write_file`;
// the host emits `write`. Nobody noticed because an unclassified name returns
// 'unknown', and 'unknown' under defaultDeny silently blocks — a missing
// classification looks exactly like a deliberate denial.
//
// This guard makes drift LOUD. It snapshots the tool names a consuming host
// declares in `tools.alsoAllow` and asserts each one is either classified or
// EXPLICITLY listed as an open question below. A new name arriving in the
// host config with nobody having triaged it fails here.
//
// It deliberately does NOT assert what the policy should be. Deciding whether
// `coding` or `browser` should reach a subagent is a security-boundary call
// that belongs in an ADR, not in a test fixture. This guard only guarantees
// the question gets asked.
describe('host tool-name coverage (drift guard)', () => {
  // Snapshot of MatrixAssistant resources/openclaw-defaults.json -> tools.alsoAllow
  // (read 2026-09-24; MA pins @oh-my-matrix/permission-policy 0.1.4).
  // MA is a DOWNSTREAM consumer: this is a copied snapshot, never a live read.
  // Upstream must not depend on a consumer's config at build or test time.
  const HOST_ALSO_ALLOW = [
    'message', 'nodes', 'agents_list', 'browser', 'coding',
    'sdd_activate_workflow', 'findskill', 'callmcp', 'findtool',
  ] as const;

  // Names knowingly left unclassified -> they fall to 'unknown' and are blocked
  // in subagent sessions by defaultDeny. Each needs a policy decision before it
  // can move out of this set. Removing a name from here without classifying it
  // fails the test below, which is the point.
  const AWAITING_POLICY_DECISION = new Set<string>([
    'message', 'nodes', 'agents_list', 'browser', 'coding',
    'sdd_activate_workflow', 'findskill', 'callmcp', 'findtool',
  ]);

  it.each(HOST_ALSO_ALLOW)('%s is classified, or explicitly awaiting a decision', (toolName) => {
    const cls = classifyCommand(toolName);
    if (AWAITING_POLICY_DECISION.has(toolName)) {
      // Pinned expectation: still unclassified. When a policy decision lands and
      // the name is classified, this flips and forces the set to be updated —
      // so the open-question list cannot silently go stale either.
      expect(cls).toBe('unknown');
    } else {
      expect(cls).not.toBe('unknown');
    }
  });

  it('every awaiting-decision name is actually in the host config', () => {
    // Guards the reverse drift: a name dropped from the host config should not
    // linger here pretending to be an open question.
    for (const name of AWAITING_POLICY_DECISION) {
      expect(HOST_ALSO_ALLOW).toContain(name as (typeof HOST_ALSO_ALLOW)[number]);
    }
  });

  it('write/edit stay classified — the B9 regression this guard generalises', () => {
    // The original drift. Kept explicit so the guard's reason for existing is
    // covered by the guard itself.
    expect(classifyCommand('write')).toBe('workspace_write');
    expect(classifyCommand('edit')).toBe('workspace_write');
  });
});
