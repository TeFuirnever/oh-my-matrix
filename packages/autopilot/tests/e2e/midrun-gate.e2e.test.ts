/**
 * E2E: E7 mid-run evidence gate — validation runs every N turns (not just
 * complete), surfacing failures early via the revise instruction.
 *
 * Real timers (execFile I/O; no patrol involved). WORKFLOW.md supplies a failing
 * validation command + midrun_validation_interval=5.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { register, _resetForTest } from '../../index';

function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  const session = {
    workflow: { enqueueNextTurnInjection: vi.fn(async () => ({ enqueued: true })) },
    state: { registerSessionExtension: vi.fn() },
  };
  return {
    api: {
      // trustWorkspace:true so the WORKFLOW.md validation commands are kept
      // (otherwise applyWorkflowConfig clears them as an untrusted-workspace guard).
      pluginConfig: { trustWorkspace: true }, session,
      on: vi.fn((h: string, fn: (...a: unknown[]) => unknown) => { hooks.set(h, fn); }),
      registerGatewayMethod: vi.fn((m: string, fn: any) => { gatewayMethods.set(m, fn); }),
    } as any,
    hooks, gatewayMethods,
  };
}

let tmpDir: string;
let originalCwd: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-e7-'));
  originalCwd = process.cwd();
  fs.writeFileSync(path.join(tmpDir, 'WORKFLOW.md'), `---
autopilot:
  version: 1
  validation:
    commands:
      - id: check
        command: node /nonexistent/e7-fail.js
        timeout_ms: 5000
        required: true
  midrun_validation_interval: 5
---
Continue.`);
  process.chdir(tmpDir);
});
afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function activate(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  await mock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey, workspacePath: tmpDir }, respond: vi.fn() });
  await mock.hooks.get('session_start')!({ sessionId: `sid-${sessionKey}`, sessionKey });
  mock.hooks.get('agent_turn_prepare')!({ prompt: 'goal' }, { sessionKey });
}

async function projectionFor(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const respond = vi.fn();
  await mock.gatewayMethods.get('autopilot.status')!({ params: { sessionKey }, respond });
  return respond.mock.calls[0][1]?.projection;
}

/** Drive one revise turn; returns the finalize result (carries retry.instruction). */
async function driveRevise(mock: ReturnType<typeof createMockApi>, sessionKey: string, sid: string) {
  const finalize = mock.hooks.get('before_agent_finalize')!;
  const result = await finalize({ sessionId: sid, sessionKey, stopHookActive: false, lastAssistantMessage: 'still working...' });
  await mock.hooks.get('agent_end')!({ sessionId: sid, sessionKey, success: true });
  return result;
}

describe('E2E: E7 mid-run evidence gate', () => {
  it('runs validation on turn N (5) and surfaces failure in the revise instruction', async () => {
    _resetForTest();
    const mock = createMockApi();
    register(mock.api);
    await activate(mock, 'sess-e7');

    // Turns 1-4: NOT divisible by 5 → no mid-run validation. Instruction is the
    // plain retry guidance (no "Mid-run validation failed").
    for (let i = 1; i <= 4; i++) {
      const r = await driveRevise(mock, 'sess-e7', 'sid-e7');
      expect(r.retry?.instruction ?? '').not.toContain('Mid-run validation failed');
    }

    // Turn 5: divisible by 5 → mid-run validation runs the failing command. Split
    // finalize/agent_end so we can also assert the E6 inflight marker was set
    // during the validation (the load-bearing E6 integration).
    const finalize = mock.hooks.get('before_agent_finalize')!;
    const turn5 = await finalize({ sessionId: 'sid-e7', sessionKey: 'sess-e7', stopHookActive: false, lastAssistantMessage: 'still working...' });
    expect(turn5.action).toBe('revise'); // still revise (not blocked)
    expect(turn5.retry?.instruction ?? '').toContain('Mid-run validation failed');
    expect(turn5.retry?.instruction ?? '').toContain('check');
    // E6 inflight guard was engaged during the mid-run validation (surfaces in projection).
    const inflightProj = await projectionFor(mock, 'sess-e7');
    expect(inflightProj.inFlightToolStartedAt).toBeTypeOf('number');
    await mock.hooks.get('agent_end')!({ sessionId: 'sid-e7', sessionKey: 'sess-e7', success: true });
  });

  it('throttle: a passing run still revives normally (no spurious failure injection on non-N turns)', async () => {
    // Sanity: the gate only fires on N. A run with the same failing command but
    // checked on turn 3 (not 5) does NOT inject the failure.
    _resetForTest();
    const mock = createMockApi();
    register(mock.api);
    await activate(mock, 'sess-e7b');
    const r = await driveRevise(mock, 'sess-e7b', 'sid-e7b'); // turn 1
    expect(r.action).toBe('revise');
    expect(r.retry?.instruction ?? '').not.toContain('Mid-run validation failed');
  });
});
