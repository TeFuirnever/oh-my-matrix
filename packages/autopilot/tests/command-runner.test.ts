/**
 * Unit tests for command-runner.ts — M5.3 evidence command execution.
 *
 * POSIX (macOS/Linux) uses `echo`, `false`, `sleep`.
 * Windows uses `cmd /c` equivalents via the conditional-shell path.
 */
import { describe, it, expect } from 'vitest';
import { runValidationCommands } from '../src/command-runner';
import type { ValidationCommand } from '../src/types';

function cmd(id: string, command: string, timeoutMs = 5000, required = true): ValidationCommand {
  return { id, command, timeoutMs, required };
}

describe('runValidationCommands', () => {
  it('returns empty array for zero commands', async () => {
    const results = await runValidationCommands([]);
    expect(results).toEqual([]);
  });

  // ── POSIX path (macOS / Linux) ──────────────────────────────────────────
  it.skipIf(process.platform === 'win32')('marks a successful command as passed with exit code 0', async () => {
    const results = await runValidationCommands([cmd('c1', 'echo hello')]);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('c1');
    expect(results[0].status).toBe('passed');
    expect(results[0].exitCode).toBe(0);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(process.platform === 'win32')('marks a failing command as failed with non-zero exit code', async () => {
    // 'false' is a POSIX command that always exits with code 1
    const results = await runValidationCommands([cmd('c2', 'false')]);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('c2');
    expect(results[0].status).toBe('failed');
    expect(results[0].exitCode).not.toBe(0);
  });

  it.skipIf(process.platform === 'win32')('marks a timed-out command as timeout', async () => {
    // 10ms timeout on a command that sleeps 2 seconds
    const results = await runValidationCommands([cmd('c3', 'sleep 2', 50)]);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('c3');
    expect(results[0].status).toBe('timeout');
  }, 5000);

  it.skipIf(process.platform === 'win32')('runs multiple commands sequentially and collects all results', async () => {
    const results = await runValidationCommands([
      cmd('ok', 'echo ok'),
      cmd('fail', 'false'),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('passed');
    expect(results[1].status).toBe('failed');
  });

  it.skipIf(process.platform === 'win32')('uses custom cwd when provided', async () => {
    // pwd in /tmp should print /tmp (or /private/tmp on macOS — both start with /tmp)
    const results = await runValidationCommands([cmd('cwd', 'pwd')], '/tmp');
    expect(results[0].status).toBe('passed');
  });

  // ── Windows path (X-15 conditional shell) ──────────────────────────────
  // These run ONLY on win32. cmd.exe `cmd /c` invocation exercises the same
  // execFile+shell:true code path that npm/pnpm .cmd wrappers use.
  it.runIf(process.platform === 'win32')('marks a successful cmd.exe command as passed', async () => {
    const results = await runValidationCommands([cmd('w1', 'cmd /c echo hello')]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('passed');
    expect(results[0].exitCode).toBe(0);
  });

  it.runIf(process.platform === 'win32')('marks a failing cmd.exe command as failed', async () => {
    // `cmd /c exit /b 1` returns exit code 1 without running anything destructive.
    const results = await runValidationCommands([cmd('w2', 'cmd /c exit /b 1')]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('failed');
    expect(results[0].exitCode).not.toBe(0);
  });

  it.runIf(process.platform === 'win32')('marks a timed-out cmd.exe command as timeout', async () => {
    // 50ms timeout on a command that pings localhost for ~3s.
    const results = await runValidationCommands([cmd('w3', 'cmd /c ping -n 3 127.0.0.1', 50)]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('timeout');
  }, 5000);

  // ── X-15 regression: cmd-injection must not escape argv ────────────────
  // parseCommandArgs splits the command string and execFile+shell:true re-quotes
  // the argv via Node's cmd-safe escaping. A bare `& dir` arg must be passed to
  // the binary as a literal arg, not interpreted by cmd.exe as a command chain.
  // We use a benign sentinel — if `&` were interpreted, the second command
  // would change observable state and the test would fail.
  it('shell metacharacters in args are passed literally (no injection)', async () => {
    // Use `node -e` which echoes its arg back; if `&` were shell-interpreted,
    // node would receive a truncated arg and the assertion below would fail.
    // Skip on platforms where `node` isn't on PATH in the test environment.
    const sentinel = 'literal&not-separated';
    const nodeCmd = `node -e "process.stdout.write(process.argv[1])" ${sentinel}`;
    const results = await runValidationCommands([cmd('inj', nodeCmd, 5000)]);
    expect(results[0].status).toBe('passed');
    // Summary won't contain stdout — we just assert the command ran and exited
    // cleanly. A real injection would have caused cmd.exe to error on `dir`
    // (no such file in cwd) or exit non-zero.
    expect(results[0].exitCode).toBe(0);
  });

  // ── X-15 regression: quoted path with spaces (Pass 3.4) ────────────────
  // parseCommandArgs must preserve a quoted space-containing token as a single
  // argv entry. If the quote-stripping broke, `node` would see a bare arg like
  // `arg` followed by separate `with` / `spaces` args — Node would still exit 0
  // for `process.exit(0)`, so we instead inject a guard: the script inspects
  // argv length and exits non-zero if the spaces weren't preserved as one token.
  it.runIf(process.platform !== 'win32')('quoted space-containing arg reaches the binary intact', async () => {
    // `node -e SCRIPT sentinel` → process.argv = [node, sentinel] (length 2).
    // If parseCommandArgs split "arg with spaces" on the inner spaces, argv
    // would be [node, 'arg', 'with', 'spaces'] (length 4) — exit 1.
    const script = 'process.exit(process.argv.length === 2 ? 0 : 1)';
    const nodeCmd = `node -e "${script}" "arg with spaces"`;
    const results = await runValidationCommands([cmd('sp', nodeCmd, 5000)]);
    expect(results[0].status).toBe('passed');
    expect(results[0].exitCode).toBe(0);
  });

  it.runIf(process.platform === 'win32')('quoted space-containing arg reaches cmd.exe intact', async () => {
    // Same guard, Windows path. parseCommandArgs splits identically; shell:true
    // then re-quotes for cmd.exe. Exit 0 only if argv arrives intact (length 2).
    const script = 'process.exit(process.argv.length === 2 ? 0 : 1)';
    const nodeCmd = `node -e "${script}" "arg with spaces"`;
    const results = await runValidationCommands([cmd('sp-win', nodeCmd, 5000)]);
    expect(results[0].status).toBe('passed');
    expect(results[0].exitCode).toBe(0);
  });

  // ── X-2: Windows timeout detection limitation ──────────────────────────
  // Document that e.code===1 cannot be used as a Windows heuristic (exit code 1
  // is also used by normal failures). The implementation must document this
  // limitation so future maintainers don't accidentally add it back and cause
  // false timeout classifications.
  it('documents Windows signal limitation in source (e.code===1 not used as timeout heuristic)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const src = fs.readFileSync(
      'src/command-runner.ts',
      'utf-8'
    );
    // Implementation must document the Windows signal limitation
    expect(src).toContain('Windows');
    // Must NOT include e.code===1 in the timedOut expression (false positive risk)
    expect(src).not.toMatch(/timedOut\s*=.*e\.code\s*===\s*1/);
    // X-15: implementation must reference the CVE / conditional shell logic
    expect(src).toContain('CVE-2024-27980');
    expect(src).toContain('shouldUseShell');
  });
});
