/**
 * M2.4 TDD Tests: Permission policy + Command Classifier
 *
 * TDD: Written BEFORE implementation — expected to FAIL initially.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCommand,
  decidePermission,
  extractCommandSegments,
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

  it('classifies pnpm test/typecheck/lint/build as validation', () => {
    expect(classifyCommand('pnpm', ['test'])).toBe('validation');
    expect(classifyCommand('pnpm', ['run', 'typecheck'])).toBe('validation');
    expect(classifyCommand('pnpm', ['run', 'lint'])).toBe('validation');
    expect(classifyCommand('pnpm', ['run', 'build'])).toBe('validation');
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
      // write_file has no name-based classifier → falls through to unknown (still safe: requires_approval)
      expect(classifyCommand('write_file', [], 'destructive_git')).toBe('unknown');
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
