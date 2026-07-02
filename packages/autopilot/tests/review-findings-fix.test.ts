/**
 * Tests for confirmed review findings (adversarial-verified).
 *
 * P0: PROD-7 — stall recovery must set needsCrossTurnResume after retry_due→claimed
 * P1: LOGIC-3 — hasNoActionableTask regex must not match "I don't have the task finished yet"
 * P1: PROD-1  — loadWorkflowConfig must surface I/O errors in warnings
 * P1: LOGIC-4 — resume gateway must set needsCrossTurnResume
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { register, _resetForTest, _triggerRetryCheckForTest, _getInternalStateForTest } from '../index';
import { orchestratorReducer } from '../src/orchestrator';
import { hasNoActionableTask } from '../src/completion-detector';
import { loadWorkflowConfig } from '../src/workflow-config';
import type { AutopilotState } from '../src/types';

/** Minimal register() mock exposing session.workflow.enqueueNextTurnInjection as a spy. */
function makeApiWithEnqueue() {
  const enqueue = vi.fn(async (inj: { sessionKey: string }) => ({
    enqueued: true,
    id: 'inj-1',
    sessionKey: inj.sessionKey,
  }));
  const api = {
    pluginConfig: {} as Record<string, unknown>,
    on: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerSessionExtension: vi.fn(),
    session: {
      workflow: { enqueueNextTurnInjection: enqueue },
      state: { registerSessionExtension: vi.fn() },
    },
  };
  return { api, enqueue };
}

// ── P0: PROD-7 — stall recovery needsCrossTurnResume ──────────────

describe('PROD-7: stall recovery sets needsCrossTurnResume', () => {
  it('retry_due → claimed sets needsCrossTurnResume: true', () => {
    const now = Date.now();
    const state: AutopilotState = {
      status: 'running',
      enabled: true,
      orchestrationState: 'retry_queued',
      retry: { attempt: 1, lastError: 'stalled', recoverable: true, nextRetryAt: now - 1000 },
      totalContinuations: 3,
      turnAttempts: 0,
      maxTotalContinuations: 200,
      maxAttemptsPerTurn: 5,
      sessionKey: 'test',
      runId: 'r1',
      totalTokensUsed: 0,
      lastActivityAt: now - 60_000,
      maxConcurrentAutopilot: 5,
      toolErrorCount: 0,
      toolErrorThreshold: 3,
      needsCrossTurnResume: false,
      degraded: false,
    };

    const updated = orchestratorReducer(state, { type: 'retry_due', runId: 'r1', now });
    expect(updated.orchestrationState).toBe('claimed');
    expect(updated.needsCrossTurnResume).toBe(true);
  });
});

// ── P1: LOGIC-3 — completion detector regex false positive ────────

describe('LOGIC-3: hasNoActionableTask regex precision', () => {
  it('must NOT match "I don\'t have the task finished yet"', () => {
    expect(hasNoActionableTask("I don't have the task finished yet")).toBe(false);
  });

  it('must NOT match "I don\'t have the task done"', () => {
    expect(hasNoActionableTask("I don't have the task done")).toBe(false);
  });

  it('must NOT match "I don\'t have the task completed"', () => {
    expect(hasNoActionableTask("I don't have the task completed")).toBe(false);
  });

  // Existing correct matches must still work
  it('still matches "I don\'t have a task"', () => {
    expect(hasNoActionableTask("I don't have a task")).toBe(true);
  });

  it('still matches "I don\'t see any task"', () => {
    expect(hasNoActionableTask("I don't see any task")).toBe(true);
  });

  it('still matches "I don\'t have a specific thing"', () => {
    expect(hasNoActionableTask("I don't have a specific thing")).toBe(true);
  });
});

// ── P1: PROD-1 — loadWorkflowConfig surfaces I/O errors ──────────

describe('PROD-1: loadWorkflowConfig surfaces read errors in warnings', () => {
  it('returns warning when WORKFLOW.md exists but is unreadable (directory)', () => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-test-'));
    // Create a directory named WORKFLOW.md — existsSync returns true, readFileSync throws EISDIR
    fs.mkdirSync(path.join(tmpDir, 'WORKFLOW.md'));

    try {
      const result = loadWorkflowConfig(tmpDir);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toMatch(/Failed to read\/parse/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── P1: LOGIC-4 — resume sets needsCrossTurnResume ────────────────

describe('LOGIC-4: resume_requested sets needsCrossTurnResume', () => {
  it('resume_requested → claimed sets needsCrossTurnResume: true', () => {
    const now = Date.now();
    const state: AutopilotState = {
      status: 'paused',
      enabled: true,
      orchestrationState: 'blocked',
      blockedReason: 'stalled',
      totalContinuations: 3,
      turnAttempts: 0,
      maxTotalContinuations: 200,
      maxAttemptsPerTurn: 5,
      sessionKey: 'test',
      runId: 'r1',
      totalTokensUsed: 0,
      lastActivityAt: now - 60_000,
      maxConcurrentAutopilot: 5,
      toolErrorCount: 0,
      toolErrorThreshold: 3,
      needsCrossTurnResume: false,
      degraded: false,
    };

    const updated = orchestratorReducer(state, { type: 'resume_requested', runId: 'r1', now });
    expect(updated.orchestrationState).toBe('claimed');
    expect(updated.needsCrossTurnResume).toBe(true);
  });
});

// ── P0: PROD-7 actuator — stall recovery must KICK a new turn ─────
// The reducer marking needsCrossTurnResume is not enough: a claimed run has no
// way to start an agent turn on its own. The stall interval must call
// enqueueNextTurnInjection so a genuinely dead agent actually restarts.

describe('PROD-7 actuator: retry_due→claimed kicks a new agent turn', () => {
  beforeEach(() => { _resetForTest(); });
  afterEach(() => { _resetForTest(); });

  it('calls enqueueNextTurnInjection when backoff expires and run becomes claimed', () => {
    const { api, enqueue } = makeApiWithEnqueue();
    register(api as never);

    const now = Date.now();
    const result = _triggerRetryCheckForTest({
      sessionKey: 'sess-kick',
      orchestrationState: 'retry_queued',
      retry: { attempt: 1, nextRetryAt: now - 1000, lastError: 'stalled', recoverable: true },
    });

    expect(result?.orchestrationState).toBe('claimed');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'sess-kick' }),
    );
  });

  it('does NOT enqueue when backoff has not expired (stays retry_queued)', () => {
    const { api, enqueue } = makeApiWithEnqueue();
    register(api as never);

    const now = Date.now();
    const result = _triggerRetryCheckForTest({
      sessionKey: 'sess-wait',
      orchestrationState: 'retry_queued',
      retry: { attempt: 1, nextRetryAt: now + 60_000, lastError: 'stalled', recoverable: true },
    });

    expect(result?.orchestrationState).toBe('retry_queued');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ── P2: PROD-2 — sessionExtension.cleanup clears reverse-index maps ─

describe('PROD-2: cleanup removes sessionKeyToRunId, not just stateByRun', () => {
  beforeEach(() => { _resetForTest(); });
  afterEach(() => { _resetForTest(); });

  it('clears both maps when the session extension is torn down', () => {
    let capturedExt: { cleanup: (ctx: { sessionKey?: string }) => void } | undefined;
    const api = {
      pluginConfig: {},
      on: vi.fn(),
      registerGatewayMethod: vi.fn(),
      session: {
        workflow: { enqueueNextTurnInjection: vi.fn(async () => ({ enqueued: true })) },
        state: { registerSessionExtension: vi.fn((ext: typeof capturedExt) => { capturedExt = ext; }) },
      },
    };
    register(api as never);

    // Seed a run so both stateByRun and sessionKeyToRunId hold an entry.
    _triggerRetryCheckForTest({ sessionKey: 'sess-cleanup', orchestrationState: 'running' });
    expect(_getInternalStateForTest().sessionKeyToRunIdSize).toBe(1);

    capturedExt!.cleanup({ sessionKey: 'sess-cleanup' });

    // Before the fix, sessionKeyToRunId kept a dangling entry (size stayed 1).
    expect(_getInternalStateForTest().sessionKeyToRunIdSize).toBe(0);
    expect(_getInternalStateForTest().stateByRunSize).toBe(0);
  });
});

// ── P2: PROD-9 — YAML parser robust to many blank/comment lines ────

describe('PROD-9: parseSimpleYaml handles heavy blank/comment noise', () => {
  it('parses a config with thousands of interspersed blank + comment lines', () => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-prod9-'));
    // 5000 comment+blank pairs between two real keys — exercises the iterative
    // skip that replaced the per-line recursion (would risk a stack blow-up).
    const noise = Array(5000).fill('  # note\n\n').join('');
    const md = `---\nautopilot:\n  version: 1\n${noise}  max_retries: 9\n---\n`;
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), md);
    try {
      const { config } = loadWorkflowConfig(dir);
      expect(config.source).toBe('workflow_md');
      expect(config.maxRetries).toBe(9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
