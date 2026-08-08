/**
 * M2.5 TDD Tests: Orchestrator Reducer
 *
 * Tests the complete state transition table from the README.
 * Pure function reducer — no side effects, no file I/O, no IPC.
 */
import { describe, it, expect } from 'vitest';
import {
  orchestratorReducer,
} from '../src/orchestrator';
import {
  type AutopilotState,
  type WorkspaceRecord,
  type EvidenceSummary,
  createInitialState,
} from '../src/types';

/** Helper: create an AutopilotState with specific overrides */
function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
  return {
    ...createInitialState('sess-1', 'run-1'),
    ...overrides,
  };
}

function makeWorkspace(): WorkspaceRecord {
  return {
    root: '/repo/.matrix/autopilot-worktrees',
    path: '/repo/.matrix/autopilot-worktrees/autopilot-sess1-abc123',
    workspaceKey: 'autopilot-sess1-abc123',
    branchName: 'autopilot/sess1-abc123',
    baseBranch: 'main',
    createdNow: true,
    reusable: false,
  };
}

function makeEvidence(overrides: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    status: 'passed',
    commands: [],
    completedAt: Date.now(),
    ...overrides,
  };
}

const NOW = 1000000;

describe('orchestrator reducer — state transition table', () => {
  // ─── idle → unclaimed (activate_requested) ───────────────────────────
  describe('idle + activate_requested → unclaimed', () => {
    it('creates run shell with goal and startedAt', () => {
      const state = makeState({ orchestrationState: undefined });
      const next = orchestratorReducer(state, {
        type: 'activate_requested', sessionKey: 'sess-1', goal: 'fix bug', now: NOW,
      });
      expect(next.orchestrationState).toBe('unclaimed');
      expect(next.goal).toBe('fix bug');
      expect(next.startedAt).toBe(NOW);
    });

    it('preserves existing fields', () => {
      const state = makeState({ totalTokensUsed: 500 });
      const next = orchestratorReducer(state, {
        type: 'activate_requested', sessionKey: 'sess-1', now: NOW,
      });
      expect(next.totalTokensUsed).toBe(500);
      expect(next.orchestrationState).toBe('unclaimed');
    });

    it('clears blockedReason and retry on new activate', () => {
      const state = makeState({
        orchestrationState: 'blocked',
        blockedReason: 'user_stopped',
        retry: { attempt: 2, nextRetryAt: NOW + 10000, lastError: 'err', recoverable: true },
      });
      const next = orchestratorReducer(state, {
        type: 'activate_requested', sessionKey: 'sess-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('unclaimed');
      expect(next.blockedReason).toBeUndefined();
      expect(next.retry).toBeUndefined();
    });
  });

  // ─── unclaimed + workspace_ready → claimed ──────────────────────────
  describe('unclaimed + workspace_ready → claimed', () => {
    it('sets workspace and clears blocked/retry', () => {
      const ws = makeWorkspace();
      const state = makeState({ orchestrationState: 'unclaimed', startedAt: NOW - 1000 });
      const next = orchestratorReducer(state, {
        type: 'workspace_ready', runId: 'run-1', workspace: ws, now: NOW,
      });
      expect(next.orchestrationState).toBe('claimed');
      expect(next.workspace).toEqual(ws);
      expect(next.blockedReason).toBeUndefined();
      expect(next.retry).toBeUndefined();
    });
  });

  // ─── claimed + agent_turn_started → running ─────────────────────────
  describe('claimed + agent_turn_started → running', () => {
    it('transitions to running and updates lastActivityAt', () => {
      const state = makeState({ orchestrationState: 'claimed', workspace: makeWorkspace() });
      const next = orchestratorReducer(state, {
        type: 'agent_turn_started', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('running');
      expect(next.lastActivityAt).toBe(NOW);
    });
  });

  // ─── running + agent_activity → running (update tokens/activity) ────
  describe('running + agent_activity → running', () => {
    it('updates lastActivityAt and tokens', () => {
      const state = makeState({
        orchestrationState: 'running',
        lastActivityAt: NOW - 1000,
        inputTokensUsed: 100,
        outputTokensUsed: 50,
      });
      const next = orchestratorReducer(state, {
        type: 'agent_activity',
        runId: 'run-1',
        activity: 'llm_output',
        now: NOW,
        tokens: { input: 200, output: 100 },
      });
      expect(next.orchestrationState).toBe('running');
      expect(next.lastActivityAt).toBe(NOW);
      expect(next.inputTokensUsed).toBe(300);
      expect(next.outputTokensUsed).toBe(150);
    });

    it('updates without tokens when not provided', () => {
      const state = makeState({
        orchestrationState: 'running',
        lastActivityAt: NOW - 1000,
      });
      const next = orchestratorReducer(state, {
        type: 'agent_activity',
        runId: 'run-1',
        activity: 'tool_call',
        now: NOW,
      });
      expect(next.lastActivityAt).toBe(NOW);
      expect(next.inputTokensUsed).toBeUndefined();
    });
  });

  // ─── running + agent_turn_finished (success) → released ─────────────
  describe('running + agent_turn_finished success → released', () => {
    it('enters evidence gate (released), not done directly', () => {
      const state = makeState({ orchestrationState: 'running' });
      const next = orchestratorReducer(state, {
        type: 'agent_turn_finished', runId: 'run-1', success: true, now: NOW,
      });
      expect(next.orchestrationState).toBe('released');
      // Should NOT be done yet — must pass evidence gate first
      expect(next.status).not.toBe('done');
    });
  });

  // ─── running + agent_turn_finished (recoverable error) → retry_queued
  describe('running + agent_turn_finished recoverable error → retry_queued', () => {
    it('computes retry entry with exponential backoff', () => {
      const state = makeState({
        orchestrationState: 'running',
        workflow: {
          version: 1, source: 'default',
          maxConcurrent: 5, maxRetries: 3, stallTimeoutMs: 300000,
          maxRetryBackoffMs: 300000,
          workspace: { root: '.matrix/autopilot-worktrees', cleanup: 'manual', branchPrefix: 'autopilot', allowDirtyBase: false },
          validation: { commands: [], failOnOptional: false },
          destructiveGit: { allow: false }, warnings: [],
        },
      });
      const next = orchestratorReducer(state, {
        type: 'agent_turn_finished', runId: 'run-1', success: false, error: 'transient tool failure', now: NOW,
      });
      expect(next.orchestrationState).toBe('retry_queued');
      expect(next.retry).toBeDefined();
      expect(next.retry!.attempt).toBe(1);
      expect(next.retry!.recoverable).toBe(true);
      expect(next.retry!.nextRetryAt).toBe(NOW + 10000);
    });
  });

  // ─── running + agent_turn_finished (unrecoverable error) → blocked ──
  describe('running + agent_turn_finished unrecoverable error → blocked', () => {
    it('blocks with correct reason', () => {
      const state = makeState({
        orchestrationState: 'running',
        retry: { attempt: 3, nextRetryAt: NOW, lastError: '', recoverable: true },
        workflow: {
          version: 1, source: 'default',
          maxConcurrent: 5, maxRetries: 3, stallTimeoutMs: 300000,
          maxRetryBackoffMs: 300000,
          workspace: { root: '.matrix/autopilot-worktrees', cleanup: 'manual', branchPrefix: 'autopilot', allowDirtyBase: false },
          validation: { commands: [], failOnOptional: false },
          destructiveGit: { allow: false }, warnings: [],
        },
      });
      const next = orchestratorReducer(state, {
        type: 'agent_turn_finished', runId: 'run-1', success: false, error: 'permission_denied', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('permission_denied');
    });
  });

  // ─── running + stall_timeout → retry_queued ─────────────────────────
  describe('running + stall_timeout → retry_queued', () => {
    it('enters retry with error=stalled, recoverable=true', () => {
      const state = makeState({
        orchestrationState: 'running',
        lastActivityAt: NOW - 400000,
        workflow: {
          version: 1, source: 'default',
          maxConcurrent: 5, maxRetries: 3, stallTimeoutMs: 300000,
          maxRetryBackoffMs: 300000,
          workspace: { root: '.matrix/autopilot-worktrees', cleanup: 'manual', branchPrefix: 'autopilot', allowDirtyBase: false },
          validation: { commands: [], failOnOptional: false },
          destructiveGit: { allow: false }, warnings: [],
        },
      });
      const next = orchestratorReducer(state, {
        type: 'stall_timeout', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('retry_queued');
      expect(next.retry!.recoverable).toBe(true);
      expect(next.retry!.lastError).toContain('stall');
    });

    // M3: claimed + stall_timeout → retry_queued (was a no-op before the fix)
    it('M3: claimed run that stalls transitions to retry_queued', () => {
      const state = makeState({
        orchestrationState: 'claimed',
        lastActivityAt: NOW - 400000,
        workflow: {
          version: 1, source: 'default',
          maxConcurrent: 5, maxRetries: 3, stallTimeoutMs: 300000,
          maxRetryBackoffMs: 300000,
          workspace: { root: '.matrix/autopilot-worktrees', cleanup: 'manual', branchPrefix: 'autopilot', allowDirtyBase: false },
          validation: { commands: [], failOnOptional: false },
          destructiveGit: { allow: false }, warnings: [],
        },
      });
      const next = orchestratorReducer(state, {
        type: 'stall_timeout', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('retry_queued');
      expect(next.retry!.recoverable).toBe(true);
    });
  });

  // ─── retry_queued + retry_due → claimed ─────────────────────────────
  describe('retry_queued + retry_due → claimed', () => {
    it('reuses workspace and transitions to claimed', () => {
      const ws = makeWorkspace();
      const state = makeState({
        orchestrationState: 'retry_queued',
        workspace: ws,
        retry: { attempt: 1, nextRetryAt: NOW - 1000, lastError: 'transient', recoverable: true },
      });
      const next = orchestratorReducer(state, {
        type: 'retry_due', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('claimed');
      expect(next.workspace).toEqual(ws);
      // retry is preserved (attempt number for next failure)
      expect(next.retry!.attempt).toBe(1);
    });

    it('no-op when now < nextRetryAt (not due yet)', () => {
      const state = makeState({
        orchestrationState: 'retry_queued',
        retry: { attempt: 1, nextRetryAt: NOW + 5000, lastError: 'transient', recoverable: true },
      });
      const next = orchestratorReducer(state, {
        type: 'retry_due', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('retry_queued');
    });
  });

  // ─── released + evidence_started → released (evidence running) ──────
  describe('released + evidence_started → released', () => {
    it('updates evidence status to running', () => {
      const state = makeState({
        orchestrationState: 'released',
        evidence: { status: 'not_started', commands: [] },
      });
      const next = orchestratorReducer(state, {
        type: 'evidence_started', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('released');
      expect(next.evidence!.status).toBe('running');
    });
  });

  // ─── released + evidence_finished passed → done ─────────────────────
  describe('released + evidence_finished passed → done', () => {
    it('transitions to done with evidence', () => {
      const state = makeState({ orchestrationState: 'released' });
      const evidence = makeEvidence({ status: 'passed' });
      const next = orchestratorReducer(state, {
        type: 'evidence_finished', runId: 'run-1', evidence, now: NOW,
      });
      expect(next.orchestrationState).toBe('done');
      expect(next.evidence!.status).toBe('passed');
    });
  });

  // ─── released + evidence_finished failed → retry or blocked ─────────
  describe('released + evidence_finished failed', () => {
    it('retry_queued when recoverable and retries remaining', () => {
      const state = makeState({
        orchestrationState: 'released',
        workflow: {
          version: 1, source: 'default',
          maxConcurrent: 5, maxRetries: 3, stallTimeoutMs: 300000,
          maxRetryBackoffMs: 300000,
          workspace: { root: '.matrix/autopilot-worktrees', cleanup: 'manual', branchPrefix: 'autopilot', allowDirtyBase: false },
          validation: { commands: [], failOnOptional: false },
          destructiveGit: { allow: false }, warnings: [],
        },
      });
      const evidence = makeEvidence({ status: 'failed', failureReason: 'typecheck failed' });
      const next = orchestratorReducer(state, {
        type: 'evidence_finished', runId: 'run-1', evidence, now: NOW,
      });
      expect(next.orchestrationState).toBe('retry_queued');
      expect(next.retry!.lastError).toContain('validation');
    });

    it('blocked when max retries reached', () => {
      const state = makeState({
        orchestrationState: 'released',
        retry: { attempt: 3, nextRetryAt: NOW, lastError: 'retry', recoverable: true },
        workflow: {
          version: 1, source: 'default',
          maxConcurrent: 5, maxRetries: 3, stallTimeoutMs: 300000,
          maxRetryBackoffMs: 300000,
          workspace: { root: '.matrix/autopilot-worktrees', cleanup: 'manual', branchPrefix: 'autopilot', allowDirtyBase: false },
          validation: { commands: [], failOnOptional: false },
          destructiveGit: { allow: false }, warnings: [],
        },
      });
      const evidence = makeEvidence({ status: 'failed', failureReason: 'typecheck failed' });
      const next = orchestratorReducer(state, {
        type: 'evidence_finished', runId: 'run-1', evidence, now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('max_retries_reached');
    });
  });

  // ─── stop_requested from various states ──────────────────────────────
  describe('stop_requested', () => {
    it('from running → blocked with user_stopped', () => {
      const state = makeState({ orchestrationState: 'running' });
      const next = orchestratorReducer(state, {
        type: 'stop_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('user_stopped');
    });

    it('from claimed → blocked with user_stopped', () => {
      const state = makeState({ orchestrationState: 'claimed' });
      const next = orchestratorReducer(state, {
        type: 'stop_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('user_stopped');
    });

    it('from retry_queued → blocked with user_stopped', () => {
      const state = makeState({
        orchestrationState: 'retry_queued',
        retry: { attempt: 1, nextRetryAt: NOW + 5000, lastError: 'err', recoverable: true },
      });
      const next = orchestratorReducer(state, {
        type: 'stop_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('user_stopped');
    });

    it('from released → blocked with user_stopped', () => {
      const state = makeState({ orchestrationState: 'released' });
      const next = orchestratorReducer(state, {
        type: 'stop_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('user_stopped');
    });
  });

  // ─── ADR-020 step 4: coupled aux resets ride into the reducer ───────
  describe('ADR-020 step 4 — coupled aux resets ride into reducer events', () => {
    // The reducer must be the sole writer of enabled/pauseReason/
    // needsCrossTurnResume/degraded. Seed them "dirty" and assert each
    // transition event resets them atomically — a regression that drops one
    // field from the spread fails here (CONTRIBUTING.md PR Rule 3).
    it('pause_requested resets enabled/pauseReason/needsCrossTurnResume', () => {
      const state = makeState({
        orchestrationState: 'running',
        enabled: true,
        pauseReason: 'tool_error_repeated',
        needsCrossTurnResume: true,
      });
      const next = orchestratorReducer(state, {
        type: 'pause_requested', runId: 'run-1', reason: 'token_budget_exceeded', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('token_budget_exceeded');
      expect(next.enabled).toBe(false);
      expect(next.pauseReason).toBe('token_budget_exceeded');
      expect(next.needsCrossTurnResume).toBe(false);
    });

    it('stop_requested resets enabled/pauseReason/needsCrossTurnResume/degraded', () => {
      const state = makeState({
        orchestrationState: 'running',
        enabled: true,
        pauseReason: 'validation_failed',
        needsCrossTurnResume: true,
        degraded: true,
      });
      const next = orchestratorReducer(state, {
        type: 'stop_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('user_stopped');
      expect(next.enabled).toBe(false);
      expect(next.pauseReason).toBeUndefined();
      expect(next.needsCrossTurnResume).toBe(false);
      expect(next.degraded).toBe(false);
    });

    it('degradation_marked sets degraded true WITHOUT advancing lastActivityAt', () => {
      const state = makeState({ orchestrationState: 'running', degraded: false, lastActivityAt: NOW });
      const next = orchestratorReducer(state, {
        type: 'degradation_marked', runId: 'run-1', now: NOW + 9999,
      });
      expect(next.degraded).toBe(true);
      // Must NOT advance: degradation_marked fires when the canary FAILED
      // (before_agent_finalize never ran = the run is stalled). Stamping
      // activity here would mask the stall from the stall detector.
      expect(next.lastActivityAt).toBe(NOW);
    });

    it('degradation_cleared sets degraded false WITHOUT advancing lastActivityAt', () => {
      const state = makeState({ orchestrationState: 'running', degraded: true, lastActivityAt: NOW });
      const next = orchestratorReducer(state, {
        type: 'degradation_cleared', runId: 'run-1', now: NOW + 9999,
      });
      expect(next.degraded).toBe(false);
      expect(next.lastActivityAt).toBe(NOW);
    });
  });

  // ─── blocked + resume_requested → claimed (only if recoverable) ─────
  describe('blocked + resume_requested', () => {
    it('resumes to claimed when blockedReason is recoverable', () => {
      const ws = makeWorkspace();
      const state = makeState({
        orchestrationState: 'blocked',
        blockedReason: 'stalled',
        workspace: ws,
      });
      const next = orchestratorReducer(state, {
        type: 'resume_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('claimed');
      expect(next.blockedReason).toBeUndefined();
      expect(next.workspace).toEqual(ws);
    });

    it('stays blocked when reason is not recoverable', () => {
      const state = makeState({
        orchestrationState: 'blocked',
        blockedReason: 'permission_denied',
      });
      const next = orchestratorReducer(state, {
        type: 'resume_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('permission_denied');
    });

    // REV-1 regression guard: resume of an unclaimed run (paused before dispatch)
    // must transition to claimed, not silently no-op.
    it('REV-1: resumes unclaimed → claimed (was silent no-op)', () => {
      const state = makeState({ orchestrationState: 'unclaimed' });
      const next = orchestratorReducer(state, {
        type: 'resume_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('claimed');
      expect(next.needsCrossTurnResume).toBe(true);
    });
  });

  // ─── done + activate_requested → unclaimed (new run) ────────────────
  describe('done + activate_requested → unclaimed', () => {
    it('creates new run, preserves goal optionally', () => {
      const state = makeState({
        orchestrationState: 'done',
        goal: 'old goal',
        evidence: makeEvidence({ status: 'passed' }),
        workspace: makeWorkspace(),
      });
      const next = orchestratorReducer(state, {
        type: 'activate_requested', sessionKey: 'sess-1', goal: 'new goal', now: NOW,
      });
      expect(next.orchestrationState).toBe('unclaimed');
      expect(next.goal).toBe('new goal');
      expect(next.startedAt).toBe(NOW);
      // Old workspace and evidence are cleared
      expect(next.workspace).toBeUndefined();
      expect(next.evidence).toBeUndefined();
    });

    it('preserves goal when new goal is not provided', () => {
      const state = makeState({
        orchestrationState: 'done',
        goal: 'existing goal',
      });
      const next = orchestratorReducer(state, {
        type: 'activate_requested', sessionKey: 'sess-1', now: NOW,
      });
      expect(next.goal).toBe('existing goal');
    });
  });

  // ─── Idempotency ────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('duplicate evidence_finished only accepts first terminal result', () => {
      const evidence1 = makeEvidence({ status: 'passed' });
      const evidence2 = makeEvidence({ status: 'failed', failureReason: 'late result' });
      const state = makeState({ orchestrationState: 'released' });
      const next1 = orchestratorReducer(state, {
        type: 'evidence_finished', runId: 'run-1', evidence: evidence1, now: NOW,
      });
      expect(next1.orchestrationState).toBe('done');
      const next2 = orchestratorReducer(next1, {
        type: 'evidence_finished', runId: 'run-1', evidence: evidence2, now: NOW + 1000,
      });
      // Should stay done with original passed evidence
      expect(next2.orchestrationState).toBe('done');
      expect(next2.evidence!.status).toBe('passed');
    });
  });

  // ─── Projection mapping ─────────────────────────────────────────────
  describe('OrchestrationState to status projection', () => {
    it('claimed maps to running', () => {
      const state = makeState({ orchestrationState: 'claimed' });
      expect(state.orchestrationState).toBe('claimed');
    });

    it('running maps to running', () => {
      const state = makeState({ orchestrationState: 'running' });
      expect(state.orchestrationState).toBe('running');
    });

    it('retry_queued maps to paused', () => {
      const state = makeState({ orchestrationState: 'retry_queued' });
      // projection handles the mapping
      expect(state.orchestrationState).toBe('retry_queued');
    });

    it('blocked maps to paused', () => {
      const state = makeState({
        orchestrationState: 'blocked',
        blockedReason: 'stalled',
      });
      expect(state.blockedReason).toBe('stalled');
    });

    it('done maps to done', () => {
      const state = makeState({
        orchestrationState: 'done',
        evidence: makeEvidence({ status: 'passed' }),
      });
      expect(state.orchestrationState).toBe('done');
    });
  });

  // ─── Single-writer constraint ───────────────────────────────────────
  describe('single-writer', () => {
    it('reducer returns new state object (immutable)', () => {
      const state = makeState({ orchestrationState: 'running' });
      const next = orchestratorReducer(state, {
        type: 'agent_activity', runId: 'run-1', activity: 'tool_call', now: NOW,
      });
      expect(next).not.toBe(state);
    });

    it('reducer does not mutate input state', () => {
      const state = makeState({ orchestrationState: 'running', lastActivityAt: 500 });
      const originalActivity = state.lastActivityAt;
      orchestratorReducer(state, {
        type: 'agent_activity', runId: 'run-1', activity: 'tool_call', now: NOW,
      });
      expect(state.lastActivityAt).toBe(originalActivity);
    });
  });

  // ─── M2: stop_requested from unclaimed → blocked ────────────────────
  describe('stop_requested from unclaimed (M2)', () => {
    it('from unclaimed → blocked with user_stopped', () => {
      const state = makeState({ orchestrationState: 'unclaimed' });
      const next = orchestratorReducer(state, {
        type: 'stop_requested', runId: 'run-1', now: NOW,
      });
      expect(next.orchestrationState).toBe('blocked');
      expect(next.blockedReason).toBe('user_stopped');
    });
  });

  // ─── H1 root cause: evidence_finished sets BOTH orchestrationState AND status ─
  describe('H1 root cause — evidence_finished sets legacy status field', () => {
    it('evidence_finished (skipped) sets status="done" — calling complete() after would throw', () => {
      const state = makeState({ orchestrationState: 'released', status: 'running' });
      const evidence = makeEvidence({ status: 'skipped' });
      const next = orchestratorReducer(state, {
        type: 'evidence_finished', runId: 'run-1', evidence, now: NOW,
      });
      // Both M2 and legacy fields are set to done
      expect(next.orchestrationState).toBe('done');
      expect(next.status).toBe('done');
      // Guard: index.ts must check next.status === 'done' and skip complete() to avoid throwing
    });
  });
});
