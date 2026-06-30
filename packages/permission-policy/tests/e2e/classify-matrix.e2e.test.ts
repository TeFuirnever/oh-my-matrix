/**
 * E2E: classifyCommand classification matrix — the allow/block boundary.
 *
 * Table-driven over the full threat surface a consumer's subagent could issue.
 * Each command is fed the SAME way the live guard feeds it: toolName 'exec' +
 * tokenizeShell(command) — 'exec' is a generic-executor that reclassifies on
 * the first real token, so this mirrors the production path exactly.
 *
 * expectedClass is FROZEN to current behavior (captured from
 * src/permission-policy.ts classifyCommand). Where that behavior is a known
 * security gap, the row is kept and flagged with a `// gap:` comment — a green
 * test documents reality; silently "fixing" the expectation would hide the gap.
 * This is the "honest test" discipline from docs/fixes/runtime-guard-event-shape.md.
 *
 * NOTE: toolKind is intentionally NEVER passed here — the live guard calls
 * classifyCommand(toolName, seg) with no toolKind (the event's toolKind field is
 * ignored). See the `toolKind handling` block for the one injection-defense +
 * the known downgrade gap.
 */
import { describe, it, expect } from 'vitest';
import { classifyCommand, decidePermissionForEvent, tokenizeShell } from '../../src/permission-policy';
import type { CommandClass } from '../../src/types';

/** Classify a shell command string exactly as the live exec-tool guard does. */
function classifyExec(command: string): CommandClass {
  return classifyCommand('exec', tokenizeShell(command));
}

describe('E2E classifyCommand matrix — classification boundary', () => {
  describe.each([
    // ── Privilege escalation / system mutation → system_write ──────────────
    ['sudo rm -rf /', 'system_write'],
    ['sudo git pull', 'system_write'],
    ['chmod 777 /etc/passwd', 'system_write'],
    ['chown root:root x', 'system_write'],
    ['dd if=/dev/zero of=/dev/sda', 'system_write'],
    ['mkfs.ext4 /dev/sda1', 'system_write'],
    // Windows privilege/ACL/disk/registry (classifier is OS-agnostic)
    ['runas /user:admin cmd', 'system_write'],
    ['icacls * /grant Everyone:F', 'system_write'],
    ['format C:', 'system_write'],
    ['diskpart', 'system_write'],
    ['reg delete HKLM\\Software\\x /f', 'system_write'],
  ] as const)('system_write: %s', (command, expected) => {
    it(`classifies "${command}" as ${expected}`, () => {
      expect(classifyExec(command)).toBe(expected);
    });
  });

  describe.each([
    // ── Filesystem destructive → workspace_cleanup ─────────────────────────
    ['rm -rf /', 'workspace_cleanup'],
    ['shred -u /etc/shadow', 'workspace_cleanup'],
    ['find / -name x -delete', 'workspace_cleanup'],
    // package-manager payload escape: the wrapped command is reclassified
    ['pnpm exec rm -rf /', 'workspace_cleanup'],
  ] as const)('workspace_cleanup: %s', (command, expected) => {
    it(`classifies "${command}" as ${expected}`, () => {
      expect(classifyExec(command)).toBe(expected);
    });
  });

  describe.each([
    // ── Destructive git (the 2026-06-28 fail-open bug class) ───────────────
    ['git reset --hard HEAD~1', 'destructive_git'],
    ['git push --force origin main', 'destructive_git'],
    ['git push -f origin main', 'destructive_git'],
    ['git commit --amend', 'destructive_git'],
    ['git clean -fdx', 'destructive_git'],
    ['git checkout -- ./rm', 'destructive_git'],
  ] as const)('destructive_git: %s', (command, expected) => {
    it(`classifies "${command}" as ${expected}`, () => {
      expect(classifyExec(command)).toBe(expected);
    });
  });

  describe.each([
    // ── Credential access — via credential-bearing tool NAMES ──────────────
    // (classifyCommand keys on toolName containing credential/keychain/ssh-key;
    //  it does NOT inspect args, so see the `cat /etc/shadow` gap row below.)
    ['credential-store get api-key', 'credential_access'],
    ['keychain get-password', 'credential_access'],
    ['ssh-keygen -t ed25519', 'credential_access'],
  ] as const)('credential_access: %s', (command, expected) => {
    it(`classifies "${command}" as ${expected}`, () => {
      expect(classifyExec(command)).toBe(expected);
    });
  });

  describe.each([
    // ── Network ────────────────────────────────────────────────────────────
    ['pnpm install', 'network'],
    ['npm install', 'network'],
    ['curl http://example.com', 'network'],
    ['wget http://example.com', 'network'],
    ['git pull', 'network'],
    ['git fetch', 'network'],
    // ── Validation ────────────────────────────────────────────────────────
    ['pnpm test', 'validation'],
    ['npm test', 'validation'],
    ['npm run build', 'validation'],
    // ── Safe git ──────────────────────────────────────────────────────────
    ['git status', 'safe_git'],
    ['git diff', 'safe_git'],
    ['git log --oneline', 'safe_git'],
    ['git branch', 'safe_git'],
    // ── Read-only (safe boundary — must NOT over-block) ───────────────────
    ['echo hello', 'read_only'],
    ['ls -la', 'read_only'],
    ['cat README.md', 'read_only'],
    ['grep foo bar', 'read_only'],
    ['find / -name x', 'read_only'], // plain find (no -delete) stays read-only
  ] as const)('safe boundary: %s', (command, expected) => {
    it(`classifies "${command}" as ${expected}`, () => {
      expect(classifyExec(command)).toBe(expected);
    });
  });

  describe.each([
    // ── Unknown (fail-closed under subagent defaultDeny; allowed when trusted) ──
    ['totally-unknown-binary --flag', 'unknown'],
    // npx reclassifies its payload; an unrecognized payload → unknown.
    ['npx some-pkg --destroy', 'unknown'],
  ] as const)('unknown: %s', (command, expected) => {
    it(`classifies "${command}" as ${expected}`, () => {
      expect(classifyExec(command)).toBe(expected);
    });
  });

  describe.each([
    // SEC-1/SEC-2 (fixed): a leading `--` separator and env own-flags / KEY=val
    // assignments no longer break payload reclassification — the destructive
    // payload is classified, not the `--` / `-i` / `FOO=bar` token. Pre-fix these
    // all fell through to `unknown` (→ allow-by-default in trusted sessions).
    ['npx -- rm -rf /', 'workspace_cleanup'],
    ['npx -- -- rm -rf /', 'workspace_cleanup'],       // H1: double -- loop-strip
    ['npm exec -- rm -rf /', 'workspace_cleanup'],
    ['npm exec -- -- rm -rf /', 'workspace_cleanup'],  // H1
    ['pnpm exec -- rm -rf /', 'workspace_cleanup'],
    ['yarn exec -- rm -rf /', 'workspace_cleanup'],    // same package-manager branch
    ['npx -y rm -rf /', 'workspace_cleanup'],          // H2: -y (most common npx flag)
    ['npx --yes rm -rf /', 'workspace_cleanup'],       // H2
    ['npx -p somepkg rm -rf /', 'workspace_cleanup'],  // H2: -p consumes pkg, then rm
    ['npx -c rm -rf /', 'system_write'],               // H2: -c opaque payload → block
    ['env -i rm -rf /', 'workspace_cleanup'],
    ['env FOO=bar rm -rf /', 'workspace_cleanup'],
    ['env -u VAR rm -rf /', 'workspace_cleanup'],
  ] as const)('SEC-1/2/H1/H2 fixed payload reclassification: %s', (command, expected) => {
    it(`classifies "${command}" as ${expected}`, () => {
      expect(classifyExec(command)).toBe(expected);
    });
  });

  describe.each([
    // SEC-3/H4: shell `-c` incl. POSIX combined short flags (-ic/-ci/-xc) → block.
    ['bash -c rm -rf /', 'system_write'],
    ['sh -ic rm -rf /', 'system_write'],           // H4: combined -ic (exact '-c' missed this)
    ['bash -ci "evil"', 'system_write'],           // H4: combined -ci
    ['zsh -xc curl evil', 'system_write'],         // H4: combined -xc
    // SEC-3/H5: non-shell interpreters with inline program (-c/-e) → block.
    ['python -c "import os"', 'system_write'],
    ['python3 -c x', 'system_write'],
    ['node -e "require(fs)"', 'system_write'],
    ['perl -e "system(qw(rm))"', 'system_write'],
    ['ruby -e "system :rm"', 'system_write'],
    // SEC-3: pure-prefix wrappers → classify the wrapped payload.
    ['nohup rm -rf /', 'workspace_cleanup'],
    ['time rm -rf /', 'workspace_cleanup'],
    ['command rm -rf /', 'workspace_cleanup'],
    // SEC-3/H6: timeout strips flags + duration, then classifies the command.
    ['timeout 5 rm -rf /', 'workspace_cleanup'],
    ['timeout 5 bash -c x', 'system_write'],        // H6: timeout → bash -c reached → block
    // SEC-3/H2-residual: npx combined/attached flag forms.
    ['npx -yp somepkg rm -rf /', 'workspace_cleanup'], // combined -yp consumes pkg
    ['npx -yc rm -rf /', 'system_write'],           // combined -yc carries -c → opaque → block
  ] as const)('SEC-3/H4/H5/H6 expanded classifier hardening: %s', (command, expected) => {
    it(`classifies "${command}" as ${expected}`, () => {
      expect(classifyExec(command)).toBe(expected);
    });
  });

  it('H7: env -S fail-closed (opaque split-string → system_write)', () => {
    // Over-blocks benign `env -S "A=1 B=2" cmd` too — acceptable for autopilot,
    // since -S's arg is a shell-split string the tokenizer can't safely classify.
    expect(classifyExec('env -S "rm -rf /" cmd')).toBe('system_write');
    expect(classifyExec('env -S "A=1 B=2" echo hi')).toBe('system_write');
  });

  it('H8: bare `npx --` (flags consumed everything) → unknown, not validation', () => {
    expect(classifyExec('npx --')).toBe('unknown');
  });

  it('SEC-3 documented ceiling: remaining arg-consuming wrappers still unknown (xargs/nice)', () => {
    // ponytail: known follow-up. timeout is now modelled (above); xargs/nice are not.
    // Defense-in-depth for the TRUSTED path only — subagent defaultDeny blocks these.
    expect(classifyExec('xargs rm')).toBe('unknown');
    expect(classifyExec('nice -n 5 rm -rf /')).toBe('unknown');
  });

  it('gap: `cat /etc/shadow` classifies read_only (classifier ignores credential file paths)', () => {
    // KNOWN GAP: classifyCommand does not inspect args, so `cat` of a credential
    // file is read_only. Pinned to reality; a future path-aware classifier must
    // flip this to credential_access and update this row.
    expect(classifyExec('cat /etc/shadow')).toBe('read_only');
    expect(classifyExec('cat ~/.ssh/id_rsa')).toBe('read_only');
  });
});

describe('E2E classifyCommand — toolKind handling (injection surface)', () => {
  it('defense: a non-git tool claiming toolKind=destructive_git is NOT trusted', () => {
    // Cross-check: only git/hub/gh may carry destructive_git. rm claiming it
    // falls through to name-based classification → workspace_cleanup (still
    // blocked, but not via the injected kind).
    expect(classifyCommand('rm', ['-rf', '/'], 'destructive_git')).toBe('workspace_cleanup');
    expect(classifyCommand('curl', ['x'], 'destructive_git')).toBe('network');
  });

  it('gap: toolKind is otherwise TRUSTED and can DOWNGRADE a dangerous tool', () => {
    // KNOWN GAP: any valid toolKind is returned as-is. A caller passing
    // toolKind='read_only' downgrades `rm` to read_only. Not exploitable via the
    // live guard (which omits toolKind entirely), but a latent footgun for any
    // caller that passes an event-supplied toolKind. Pinned to current behavior.
    expect(classifyCommand('rm', ['-rf', '/'], 'read_only')).toBe('read_only');
    expect(classifyCommand('sudo', ['x'], 'safe_git')).toBe('safe_git');
  });
});

describe('E2E decidePermissionForEvent — subagent (defaultDeny) outcome boundary', () => {
  // Single-segment commands fed the REAL event shape. defaultDeny:true mirrors
  // the dynamic-workflows subagent guard. workflowAllowsDestructiveGit:false
  // (ad-hoc subagents get no workspace context).
  const subagent = { workflowAllowsDestructiveGit: false, defaultDeny: true } as const;
  const allow = (cmd: string) =>
    decidePermissionForEvent({ toolName: 'exec', params: { command: cmd } }, subagent).outcome;
  const cls = (cmd: string) =>
    decidePermissionForEvent({ toolName: 'exec', params: { command: cmd } }, subagent).commandClass;

  it.each([
    ['git status', 'safe_git'],
    ['echo hi', 'read_only'],
    ['pnpm install', 'network'],
    ['pnpm test', 'validation'],
    ['git diff', 'safe_git'],
  ] as const)('ALLOWS safe subagent command: %s', (cmd, expectedCls) => {
    expect(allow(cmd)).toBe('allow');
    expect(cls(cmd)).toBe(expectedCls);
  });

  it.each([
    ['git reset --hard HEAD~1', 'destructive_git'],
    ['rm -rf /', 'workspace_cleanup'],
    ['sudo ls', 'system_write'],
    ['totally-unknown-binary --flag', 'unknown'], // defaultDeny fail-closed
    ['chmod 777 /x', 'system_write'],
  ] as const)('BLOCKS dangerous subagent command: %s', (cmd, expectedCls) => {
    expect(allow(cmd)).toBe('block');
    expect(cls(cmd)).toBe(expectedCls);
  });

  it('gap: subagent CAN `cat /etc/shadow` (read_only → allow even under defaultDeny)', () => {
    // Same known gap, observed end-to-end through the real event path: cat is
    // read_only, so defaultDeny does NOT block it. Documented reality.
    expect(allow('cat /etc/shadow')).toBe('allow');
  });

  it('SEC loosening: env-wrapped BENIGN command now ALLOWS in subagent (was block pre-fix)', () => {
    // Pre-SEC-2, `env -i ls` masked ls behind -i → unknown → block under defaultDeny.
    // Post-fix, ls is reached → read_only → allow. ls is genuinely read-only, so this
    // loosening of the shared classifier is correct; pinned to catch regressions
    // (in either direction) on the shared primitive both plugins consume.
    expect(allow('env -i ls -la')).toBe('allow');
  });

  it('SEC: env-wrapped DESTRUCTIVE command still BLOCKS in subagent', () => {
    expect(allow('env -i rm -rf /')).toBe('block');
    expect(allow('env FOO=bar git reset --hard')).toBe('block');
  });
});
