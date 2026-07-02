/**
 * Tests for confirmed review findings (adversarial-verified).
 *
 * P0: PROD-7 — stall recovery must set needsCrossTurnResume after retry_due→claimed
 * P1: LOGIC-3 — hasNoActionableTask regex must not match "I don't have the task finished yet"
 * P1: PROD-1  — loadWorkflowConfig must surface I/O errors in warnings
 * P1: LOGIC-4 — resume gateway must set needsCrossTurnResume
 */
import { describe, it, expect } from 'vitest';
import { orchestratorReducer } from '../src/orchestrator';
import { hasNoActionableTask } from '../src/completion-detector';
import { loadWorkflowConfig } from '../src/workflow-config';
import type { AutopilotState } from '../src/types';

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
