/**
 * T7+T8 E2E: REAL evidence-gate process spawn via command-runner.runValidationCommands.
 *
 * This is the placebo-bug discipline suite: it drives the ONLY real
 * child_process.execFile spawn in the repo (command-runner.ts) and asserts
 * ACTUAL behavior — exit 0 → passed/done, nonzero → failed/blocked-or-retry.
 * execFile is NOT mocked; commands run against real os.tmpdir() scripts.
 *
 * The pure evaluateEvidence() is already unit-tested elsewhere; here we assert
 * the SPAWN WIRING + the outcome→EvidenceSummary mapping that the orchestrator's
 * complete/evidence path depends on. We also drive the project-type
 * auto-detection matrix (detectValidationCommands → runValidationCommands) end
 * to end so a manifest→cmd→spawn regression fails red here.
 *
 * Why not drive the public register() API? The complete path lives inside the
 * `before_agent_finalize` hook, gated by completion-detection heuristics
 * (MIN_TURNS_BEFORE_COMPLETE etc.) that would make the spawn a side-effect of a
 * large, flaky drive. Testing runValidationCommands directly with a real tmpdir
 * script is still a real-process E2E — the same function index.ts calls — and
 * isolates the spawn seam we care about.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { runValidationCommands, parseCommandArgs } from '../../src/command-runner';
import { evaluateEvidence } from '../../src/evidence-gate';
import { detectValidationCommands } from '../../src/project-detector';
import type { ValidationCommand } from '../../src/types';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-e2e-execfile-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a small node script that exits with the given code.
 * Using `node <script>` (not a bare shell `true`/`false`) keeps the suite
 * portable across platforms and exercises parseCommandArgs quote handling.
 */
function writeExitScript(name: string, code: number): string {
  const file = path.join(tmpDir, `${name}.mjs`);
  fs.writeFileSync(file, `process.exit(${code});\n`);
  return file;
}

/** Build a ValidationCommand pointing its `command` at `node <abs script path>`. */
function nodeCmd(id: string, scriptPath: string, timeoutMs = 10_000, required = true): ValidationCommand {
  return { id, command: `node ${scriptPath}`, timeoutMs, required };
}

describe('E2E evidence-gate — REAL execFile spawn (command-runner.runValidationCommands)', () => {
  describe('exit-code → EvidenceCommandResult mapping', () => {
    it('exit 0 → status passed, exitCode 0 (the orchestrator complete/done path)', async () => {
      const script = writeExitScript('ok', 0);
      const cmd = nodeCmd('c1', script);
      const results = await runValidationCommands([cmd], tmpDir);

      expect(results).toHaveLength(1);
      // frozen to current behavior: command-runner.ts:38-43 sets status:'passed', exitCode:0
      // on the null-error branch (execFile callback resolves only on exit 0).
      expect(results[0].id).toBe('c1');
      expect(results[0].status).toBe('passed');
      expect(results[0].exitCode).toBe(0);
      expect(results[0].command).toBe(cmd.command);
      expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('nonzero exit → status failed, exitCode preserved (the orchestrator retry/blocked path)', async () => {
      const script = writeExitScript('fail', 3);
      const cmd = nodeCmd('c2', script);
      const results = await runValidationCommands([cmd], tmpDir);

      expect(results).toHaveLength(1);
      // frozen to current behavior: command-runner.ts:55-64. The thrown error carries
      // e.code as the numeric exit (Node's execFile error.code === exit code on non-zero).
      expect(results[0].status).toBe('failed');
      expect(results[0].exitCode).toBe(3);
      expect(typeof results[0].summary).toBe('string');
    });

    it('timeout → status timeout (Node kills the process; killed:true + SIGTERM)', async () => {
      // setInterval keeps the node event loop alive WITHOUT installing a SIGTERM
      // handler, so Node's default handler honors the kill. execFile then reports
      // killed:true + signal:'SIGTERM' → command-runner.ts:55 maps to 'timeout'.
      const file = path.join(tmpDir, 'slow.mjs');
      fs.writeFileSync(file, `setInterval(() => {}, 1000);\n`);
      const cmd: ValidationCommand = {
        id: 'c-slow',
        command: `node ${file}`,
        // 200ms — short enough to fire Node's timeout kill fast, long enough to spawn.
        timeoutMs: 200,
        required: true,
      };
      const results = await runValidationCommands([cmd], tmpDir);

      expect(results).toHaveLength(1);
      // frozen to current behavior: command-runner.ts:55 detects timeout via
      // e.killed===true || e.signal==='SIGTERM' || e.signal==='SIGKILL' || e.code==='ETIMEDOUT'.
      // X-2 note: on Windows the kill uses TerminateProcess; e.killed is still true.
      expect(results[0].status).toBe('timeout');
    });

    /**
     * PLAN-VS-CODE MISMATCH (frozen to current behavior — NOT fixed, per the
     * "honest test" principle; flagged here so a future fix is deliberate).
     *
     * A process that swallows SIGTERM (e.g. an unsettled promise keeping the
     * event loop alive, with no default handler to honor the kill) does NOT get
     * classified as 'timeout'. execFile reports killed:false, signal:null,
     * code:13 (numeric) → command-runner.ts:55's timeout guard misses it and
     * the result is 'failed' with exitCode 13.
     *
     * The plan's prose ("nonzero → failed/retry or blocked") implies the exit
     * path; the CODE classifies this as a plain failure. A real long-running
     * validator that ignores SIGTERM would surface as 'failed', not 'timeout',
     * which has different orchestrator consequences (validation_failed vs
     * timeout semantics). Documenting, not patching.
     */
    it('SIGTERM-swallowing process → status failed with exitCode 13 (NOT timeout — frozen mismatch)', async () => {
      const file = path.join(tmpDir, 'trap-sigterm.mjs');
      // An unsettled top-level await keeps the process alive; node emits no
      // default-exit on SIGTERM because the microtask queue never drains.
      fs.writeFileSync(file, `await new Promise(() => {});\n`);
      const cmd: ValidationCommand = {
        id: 'c-trap',
        command: `node ${file}`,
        timeoutMs: 200,
        required: true,
      };
      const results = await runValidationCommands([cmd], tmpDir);

      expect(results).toHaveLength(1);
      // frozen: this IS the current behavior on Node 22 / darwin. killed:false,
      // signal:null, code:13 → command-runner classifies 'failed'.
      expect(results[0].status).toBe('failed');
      expect(results[0].exitCode).toBe(13);
    });

    it('ENOENT (missing binary) → status failed, NOT timeout', async () => {
      const cmd: ValidationCommand = {
        id: 'c-enoent',
        command: 'this-binary-does-not-exist-xyz arg1',
        timeoutMs: 5_000,
        required: true,
      };
      const results = await runValidationCommands([cmd], tmpDir);

      expect(results).toHaveLength(1);
      // frozen to current behavior: a missing binary surfaces as e.code === 'ENOENT'
      // (a string, not a number) → exitCode undefined, status 'failed'. The timeout
      // guard requires e.killed / SIGTERM / ETIMEDOUT, none of which ENOENT sets.
      expect(results[0].status).toBe('failed');
      expect(results[0].exitCode).toBeUndefined();
    });

    it('empty commands array → empty results (no spawn attempted)', async () => {
      const results = await runValidationCommands([], tmpDir);
      expect(results).toEqual([]);
    });
  });

  describe('multiple commands run sequentially, results in order', () => {
    it('preserves command order and aggregates pass + fail', async () => {
      const ok = writeExitScript('ok2', 0);
      const bad = writeExitScript('bad2', 1);
      const cmds = [nodeCmd('first', ok), nodeCmd('second', bad), nodeCmd('third', ok)];
      const results = await runValidationCommands(cmds, tmpDir);

      expect(results.map((r) => r.id)).toEqual(['first', 'second', 'third']);
      expect(results[0].status).toBe('passed');
      expect(results[1].status).toBe('failed');
      expect(results[2].status).toBe('passed');
    });
  });

  describe('results → EvidenceSummary via evaluateEvidence (the complete-path wiring)', () => {
    it('all required pass → EvidenceSummary status passed (orchestrator marks done)', async () => {
      const ok = writeExitScript('ev-ok', 0);
      const cmds = [nodeCmd('req1', ok)];
      const results = await runValidationCommands(cmds, tmpDir);

      const summary = evaluateEvidence({
        commands: cmds,
        results,
        diffSummary: '',
        now: 1_000,
      });
      // frozen to current behavior: evidence-gate.ts:89-94. All required passed
      // (no failedRequiredIds, no failOnOptional) → 'passed'. index.ts:415 then
      // sees updated.status==='done' (set by evidence_finished reducer) and skips
      // complete() — this is the H1 guard.
      expect(summary.status).toBe('passed');
      expect(summary.failureReason).toBeUndefined();
      expect(summary.commands).toBe(results);
    });

    it('a required command fails → EvidenceSummary status failed (orchestrator blocks/retries)', async () => {
      const bad = writeExitScript('ev-bad', 2);
      const cmds = [nodeCmd('req-fail', bad, 10_000, true)];
      const results = await runValidationCommands(cmds, tmpDir);

      const summary = evaluateEvidence({
        commands: cmds,
        results,
        diffSummary: '',
        now: 1_000,
      });
      // frozen to current behavior: evidence-gate.ts:68-75. Required fail →
      // failureReason names the failing id(s). Orchestrator maps evidence 'failed'
      // to blockedReason 'validation_failed' / retry path.
      expect(summary.status).toBe('failed');
      expect(summary.failureReason).toContain('req-fail');
    });

    it('optional command fails, failOnOptional=false → status passed (optional failures acceptable)', async () => {
      const bad = writeExitScript('ev-opt-bad', 1);
      const cmds: ValidationCommand[] = [
        { id: 'opt-fail', command: `node ${bad}`, timeoutMs: 10_000, required: false },
      ];
      const results = await runValidationCommands(cmds, tmpDir);

      const summary = evaluateEvidence({
        commands: cmds,
        results,
        diffSummary: '',
        now: 1_000,
        failOnOptional: false,
      });
      // frozen to current behavior: evidence-gate.ts:78-94. Optional failure with
      // failOnOptional=false falls through to 'passed'.
      expect(summary.status).toBe('passed');
    });

    it('no validation commands → EvidenceSummary status skipped', () => {
      // Mirrors index.ts:386-395 when state.workflow.validation.commands is empty:
      // runValidationCommands is NOT called, results=[], evaluateEvidence returns skipped.
      const summary = evaluateEvidence({
        commands: [],
        results: [],
        diffSummary: '',
        now: 1_000,
      });
      expect(summary.status).toBe('skipped');
      expect(summary.failureReason).toContain('no validation commands');
    });
  });

  describe('cwd containment — commands execute in the requested workspace', () => {
    it('runs the script with cwd set to tmpDir (real side effect observable)', async () => {
      // Script writes a sentinel file into its cwd; we assert it lands in tmpDir.
      const file = path.join(tmpDir, 'cwd-probe.mjs');
      fs.writeFileSync(
        file,
        `import { writeFileSync } from 'fs';\nwriteFileSync(process.cwd() + '/sentinel.txt', 'here');\n`,
      );
      const cmd = nodeCmd('cwd', file);
      await runValidationCommands([cmd], tmpDir);

      // Real fs side effect — the spawn honored cwd=tmpDir.
      expect(fs.existsSync(path.join(tmpDir, 'sentinel.txt'))).toBe(true);
    });
  });
});

describe('E2E parseCommandArgs — quote-aware binary/args split (command-runner seam)', () => {
  // These pin the parser that decides bin vs args for every execFile call above.
  // A regression here (e.g. a path-with-spaces mis-split) would break the spawn.
  it('splits bare command', () => {
    expect(parseCommandArgs('node script.mjs')).toEqual(['node', 'script.mjs']);
  });

  it('preserves single-quoted path with spaces', () => {
    const parts = parseCommandArgs("node '/path with spaces/s.mjs'");
    expect(parts).toEqual(['node', '/path with spaces/s.mjs']);
  });

  it('preserves double-quoted path with spaces', () => {
    const parts = parseCommandArgs('node "/path with spaces/s.mjs"');
    expect(parts).toEqual(['node', '/path with spaces/s.mjs']);
  });

  it('passes multiple args', () => {
    expect(parseCommandArgs('node a.mjs --flag value')).toEqual([
      'node', 'a.mjs', '--flag', 'value',
    ]);
  });
});

/**
 * T8: project-type auto-detection matrix — drive detectValidationCommands
 * (writing REAL lockfiles/manifests in a tmpdir) and, where a portable
 * toolchain exists, confirm the detected command string. We do NOT assert
 * that `npm test`/`go test` actually run (toolchains vary by host); we assert
 * the detected COMMAND STRING, which is the contract index.ts:842-844 consumes
 * when auto-filling validation commands for a workspace.
 *
 * On the host repo, npm/node ARE available, so the Node branch additionally
 * spawns the detected `npm test` against a real package.json test script and
 * asserts exit 0 → passed. The Go/Rust/Python branches assert the detected
 * command string only (their toolchains may be absent in CI).
 */
describe('E2E project-type auto-detection matrix (detectValidationCommands)', () => {
  it('pnpm-lock.yaml + package.json(test) → command contains "pnpm test"', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo ok' } }),
    );
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '');
    const cmds = detectValidationCommands(tmpDir);
    // frozen to current behavior: project-detector.ts:44 picks pnpm over yarn/npm.
    const nodeCmdEntry = cmds.find((c) => c.id === 'node-test');
    expect(nodeCmdEntry).toBeDefined();
    expect(nodeCmdEntry!.command).toContain('pnpm');
    expect(nodeCmdEntry!.required).toBe(true);
  });

  it('yarn.lock + package.json(test) → command contains "yarn test"', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } }),
    );
    fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '');
    const cmds = detectValidationCommands(tmpDir);
    expect(cmds.find((c) => c.id === 'node-test')?.command).toContain('yarn');
  });

  it('no lockfile + package.json(test) → falls back to "npm test"', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } }),
    );
    const cmds = detectValidationCommands(tmpDir);
    expect(cmds.find((c) => c.id === 'node-test')?.command).toContain('npm');
  });

  it('package.json without test script → no node-test command emitted', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'x' }));
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '');
    expect(detectValidationCommands(tmpDir).some((c) => c.id === 'node-test')).toBe(false);
  });

  it('go.mod → "go test ./..." required command', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module x\n\ngo 1.21\n');
    const goCmd = detectValidationCommands(tmpDir).find((c) => c.id === 'go-test');
    expect(goCmd?.command).toBe('go test ./...');
    expect(goCmd?.required).toBe(true);
  });

  it('Cargo.toml → "cargo test" with 180s timeout', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "x"\n');
    const cargoCmd = detectValidationCommands(tmpDir).find((c) => c.id === 'cargo-test');
    expect(cargoCmd?.command).toBe('cargo test');
    // frozen to current behavior: project-detector.ts:71 gives cargo a longer timeout.
    expect(cargoCmd?.timeoutMs).toBe(180_000);
  });

  it('pyproject.toml → "python -m pytest" as OPTIONAL (required=false)', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[tool.pytest]\n');
    const pyCmd = detectValidationCommands(tmpDir).find((c) => c.id === 'pytest');
    expect(pyCmd?.command).toBe('python -m pytest');
    // frozen to current behavior: project-detector.ts:86 marks python as required:false.
    expect(pyCmd?.required).toBe(false);
  });

  it('requirements.txt → pytest detected', () => {
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'pytest\n');
    expect(detectValidationCommands(tmpDir).some((c) => c.id === 'pytest')).toBe(true);
  });

  it('empty directory → empty command list (fallback / no validation)', () => {
    expect(detectValidationCommands(tmpDir)).toEqual([]);
  });

  it('non-existent directory → empty command list (no throw)', () => {
    expect(detectValidationCommands('/nonexistent/xyz/abc-123')).toEqual([]);
  });

  /**
   * Full round-trip: manifest → detected command → REAL spawn → passed.
   * Node+npm are guaranteed on the host repo (it's a pnpm monorepo, npm is on
   * PATH). We write a package.json whose test script exits 0, then feed the
   * detected command straight into runValidationCommands.
   */
  it('Node full round-trip: detect "npm test" → runValidationCommands → passed (REAL spawn)', async () => {
    // test script writes a sentinel so we prove the spawn really ran npm.
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        scripts: {
          // Touch a file in cwd as proof of execution.
          test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'1\')"',
        },
      }),
    );
    const detected = detectValidationCommands(tmpDir);
    const nodeTest = detected.find((c) => c.id === 'node-test')!;
    expect(nodeTest).toBeDefined();

    // Detected command is "npm test" (no lockfile → npm fallback). Spawn it for real
    // with cwd=tmpDir so npm finds the package.json we just wrote.
    const results = await runValidationCommands([nodeTest], tmpDir);
    expect(results[0].status).toBe('passed');
    expect(results[0].exitCode).toBe(0);
    // Real side effect of the spawned `npm test`.
    expect(fs.existsSync(path.join(tmpDir, 'ran.txt'))).toBe(true);
  });
});
