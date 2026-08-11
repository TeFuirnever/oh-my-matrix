/**
 * M2.1 TDD Tests: Types + Projection extension
 *
 * Verifies M2 orchestration types, projection fields,
 * and backward compatibility with existing data.
 */
import { describe, it, expect } from 'vitest';
import { projectState } from '../src/projection';
import {
  type AutopilotState,
  type OrchestrationState,
  type BlockedReason,
  type EvidenceStatus,
  type CommandClass,
  type WorkspaceRecord,
  type RetryEntry,



  type WorkflowConfig,
  type OrchestratorEvent,
  createInitialState,
} from '../src/types';

describe('M2 types', () => {
  describe('OrchestrationState', () => {
    it('has all 7 states', () => {
      const states: OrchestrationState[] = [
        'unclaimed', 'claimed', 'running', 'retry_queued', 'released', 'blocked', 'done',
      ];
      expect(states).toHaveLength(7);
    });
  });

  describe('BlockedReason', () => {
    it('has all 10 reasons from README', () => {
      const reasons: BlockedReason[] = [
        'permission_denied', 'workspace_containment_failed', 'workspace_create_failed',
        'validation_failed', 'evidence_missing', 'stalled', 'token_budget_exceeded',
        'user_stopped', 'config_invalid', 'max_retries_reached',
      ];
      expect(reasons).toHaveLength(10);
    });
  });

  describe('EvidenceStatus', () => {
    it('has all 5 statuses', () => {
      const statuses: EvidenceStatus[] = ['not_started', 'running', 'passed', 'failed', 'skipped'];
      expect(statuses).toHaveLength(5);
    });
  });

  describe('CommandClass', () => {
    it('has all 11 classes from README', () => {
      const classes: CommandClass[] = [
        'read_only', 'workspace_write', 'validation', 'safe_git',
        'worktree_create', 'workspace_cleanup', 'destructive_git',
        'network', 'credential_access', 'system_write', 'unknown',
      ];
      expect(classes).toHaveLength(11);
    });
  });

  describe('WorkspaceRecord', () => {
    it('accepts full record', () => {
      const rec: WorkspaceRecord = {
        root: '/repo/.matrix/autopilot-worktrees',
        path: '/repo/.matrix/autopilot-worktrees/autopilot-sess1-abc123',
        workspaceKey: 'autopilot-sess1-abc123',
        branchName: 'autopilot/sess1-abc123',
        baseBranch: 'main',
        createdNow: true,
        reusable: false,
        lastVerifiedAt: Date.now(),
      };
      expect(rec.path).toContain('autopilot-');
    });
  });

  describe('RetryEntry', () => {
    it('accepts retry metadata', () => {
      const entry: RetryEntry = {
        attempt: 2, nextRetryAt: Date.now() + 10000,
        lastError: 'transient tool failure', recoverable: true,
      };
      expect(entry.recoverable).toBe(true);
    });
  });

  describe('WorkflowConfig', () => {
    it('accepts full config', () => {
      const config: WorkflowConfig = {
        version: 1, source: 'workflow_md',
        maxConcurrent: 5, maxRetries: 3, stallTimeoutMs: 300000,
        maxRetryBackoffMs: 300000,
        workspace: { cleanup: 'manual', branchPrefix: 'autopilot', allowDirtyBase: false },
        validation: { commands: [], failOnOptional: false },
        destructiveGit: { allow: false }, warnings: [],
      };
      expect(config.version).toBe(1);
    });
  });

  describe('OrchestratorEvent', () => {
    it('accepts activate_requested', () => {
      const event: OrchestratorEvent = { type: 'activate_requested', sessionKey: 's1', now: Date.now() };
      expect(event.type).toBe('activate_requested');
    });
    it('accepts evidence_finished', () => {
      const event: OrchestratorEvent = {
        type: 'evidence_finished', runId: 'r1',
        evidence: { status: 'passed', commands: [], completedAt: Date.now() }, now: Date.now(),
      };
      expect(event.type).toBe('evidence_finished');
    });
  });
});

describe('M2 AutopilotState extensions', () => {
  it('createInitialState returns existing fields unchanged', () => {
    const state = createInitialState('s1', 'r1');
    expect(state.status).toBe('idle');
    expect(state.enabled).toBe(false);
    expect(state.degraded).toBe(false);
  });

  it('createInitialState has undefined M2 optional fields', () => {
    const state = createInitialState('s1', 'r1');
    expect(state.orchestrationState).toBeUndefined();
    expect(state.workspace).toBeUndefined();
    expect(state.retry).toBeUndefined();
    expect(state.blockedReason).toBeUndefined();
    expect(state.evidence).toBeUndefined();
    expect(state.inputTokensUsed).toBeUndefined();
    expect(state.outputTokensUsed).toBeUndefined();
  });

  it('AutopilotState accepts M2 fields', () => {
    const state: AutopilotState = {
      ...createInitialState('s1', 'r1'),
      orchestrationState: 'running',
      inputTokensUsed: 1000, outputTokensUsed: 500,
    };
    expect(state.orchestrationState).toBe('running');
    expect(state.inputTokensUsed).toBe(1000);
  });
});

describe('M2 Projection extensions', () => {
  it('projectState includes existing fields unchanged', () => {
    const state = { ...createInitialState('s', 'r'), status: 'running' as const, goal: 'test' };
    const proj = projectState(state)!;
    expect(proj.status).toBe('running');
    expect(proj.canStop).toBe(true);
    expect(proj.lastGoal).toBe('test');
  });

  it('projectState includes M2 fields when state has them', () => {
    const now = Date.now();
    const state: AutopilotState = {
      ...createInitialState('s', 'r'),
      orchestrationState: 'running',
      workspace: {
        root: '/repo/.matrix/worktrees', path: '/repo/.matrix/worktrees/autopilot-s-abc',
        workspaceKey: 'autopilot-s-abc', branchName: 'autopilot/s-abc',
        baseBranch: 'main', createdNow: true, reusable: false,
      },
      retry: { attempt: 1, nextRetryAt: now + 10000, lastError: 'timeout', recoverable: true },
      startedAt: now - 60000, lastActivityAt: now,
      evidence: { status: 'not_started', commands: [] },
      inputTokensUsed: 2000, outputTokensUsed: 800,
    };
    const proj = projectState(state)!;
    expect(proj.orchestrationState).toBe('running');
    expect(proj.workspacePath).toContain('autopilot-s-abc');
    expect(proj.workspaceBranch).toBe('autopilot/s-abc');
    expect(proj.retryCount).toBe(1);
    expect(proj.runtimeMs).toBeGreaterThan(0);
    expect(proj.inputTokensUsed).toBe(2000);
    expect(proj.outputTokensUsed).toBe(800);
    expect(proj.evidenceStatus).toBe('not_started');
  });

  it('projectState returns safe defaults when state lacks M2 fields', () => {
    const state = createInitialState('s', 'r');
    const proj = projectState(state)!;
    expect(proj.orchestrationState).toBeUndefined();
    expect(proj.workspacePath).toBeUndefined();
    expect(proj.retryCount).toBe(0);
    expect(proj.runtimeMs).toBe(0);
    expect(proj.inputTokensUsed).toBe(0);
    expect(proj.outputTokensUsed).toBe(0);
  });

  it('projectState includes evidence details', () => {
    const state: AutopilotState = {
      ...createInitialState('s', 'r'),
      evidence: {
        status: 'passed', diffSummary: '2 files changed',
        commands: [{ id: 'test', command: 'pnpm test', status: 'passed', durationMs: 3000, summary: 'ok' }],
        completedAt: Date.now(),
      },
    };
    const proj = projectState(state)!;
    expect(proj.evidenceStatus).toBe('passed');
    expect(proj.evidenceSummary).toBe('2 files changed');
    expect(proj.lastEvidenceCommands).toHaveLength(1);
  });

  it('projectState includes workflow source', () => {
    const state: AutopilotState = {
      ...createInitialState('s', 'r'),
      workflow: {
        version: 1, source: 'workflow_md',
        maxConcurrent: 5, maxRetries: 3, stallTimeoutMs: 300000,
        maxRetryBackoffMs: 300000,
        workspace: { cleanup: 'manual', branchPrefix: 'autopilot', allowDirtyBase: false },
        validation: { commands: [], failOnOptional: false },
        destructiveGit: { allow: false }, warnings: [],
      },
    };
    const proj = projectState(state)!;
    expect(proj.workflowSource).toBe('workflow_md');
  });

  it('runtimeMs is computed from startedAt to now while running', () => {
    const startedAt = Date.now() - 30000;
    const state: AutopilotState = { ...createInitialState('s', 'r'), status: 'running', startedAt, lastActivityAt: Date.now() };
    const proj = projectState(state)!;
    expect(proj.runtimeMs).toBeGreaterThanOrEqual(25000);
    expect(proj.runtimeMs).toBeLessThanOrEqual(35000);
  });

  it('runtimeMs freezes at lastActivityAt for terminated runs (not wall-clock)', () => {
    const startedAt = Date.now() - 60000;
    const state: AutopilotState = { ...createInitialState('s', 'r'), status: 'paused', startedAt, lastActivityAt: Date.now() - 20000 };
    const proj = projectState(state)!;
    expect(proj.runtimeMs).toBeGreaterThanOrEqual(35000);
    expect(proj.runtimeMs).toBeLessThanOrEqual(45000);
  });
});
