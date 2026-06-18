/**
 * Tier 4: Test Coverage Integration Tests
 *
 * TDD: Written BEFORE any production code changes.
 * Covers:
 *   T-1: workflow-config → permission-policy linkage
 *   T-2: evidence-gate + command-runner pipeline
 *   T-3: stall-detector + orchestrator reducer with fake timers
 */
import { describe, it, expect } from 'vitest';
import { decidePermission } from '../src/permission-policy';
import { evaluateEvidence } from '../src/evidence-gate';
import { runValidationCommands } from '../src/command-runner';
import { checkStall } from '../src/stall-detector';
import { orchestratorReducer } from '../src/orchestrator';
import { DEFAULT_WORKFLOW_CONFIG } from '../src/workflow-config';
import type { AutopilotState, OrchestratorEvent, ValidationCommand, WorkflowConfig } from '../src/types';

// ─── T-1: workflow-config → permission-policy linkage ──────────────
// Verifies that WorkflowConfig output correctly feeds into decidePermission
// via workflowAllowsDestructiveGit flag.
// (loadWorkflowConfig parsing is tested in workflow-config.test.ts;
//  here we test the data-flow integration between the two modules.)

describe('T-1: workflow-config → permission-policy linkage', () => {
  it('destructiveGit.allow=true allows destructive git', () => {
    // Simulate config loaded from WORKFLOW.md with destructive_git: { allow: true }
    const config: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG, destructiveGit: { allow: true } };

    const decision = decidePermission({
      toolName: 'bash',
      command: ['git', 'reset', '--hard'],
      cwd: '/repo/.matrix/worktrees/autopilot-s1',
      workspacePath: '/repo/.matrix/worktrees/autopilot-s1',
      workflowAllowsDestructiveGit: config.destructiveGit.allow,
    });

    expect(decision.outcome).toBe('allow');
    expect(decision.reason).toContain('Destructive git');
  });

  it('destructiveGit.allow=false (default) blocks destructive git', () => {
    const config: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG };
    expect(config.destructiveGit.allow).toBe(false);

    const decision = decidePermission({
      toolName: 'bash',
      command: ['git', 'reset', '--hard'],
      cwd: '/repo/.matrix/worktrees/autopilot-s1',
      workspacePath: '/repo/.matrix/worktrees/autopilot-s1',
      workflowAllowsDestructiveGit: config.destructiveGit.allow,
    });

    expect(decision.outcome).toBe('block');
  });

  it('validation commands from config have correct shape for evidence pipeline', () => {
    // Verify WorkflowConfig.validation.commands structure matches ValidationCommand[]
    const config: WorkflowConfig = {
      ...DEFAULT_WORKFLOW_CONFIG,
      validation: {
        commands: [
          { id: 'unit-test', command: 'echo pass', timeoutMs: 5000, required: true },
          { id: 'lint', command: 'pnpm lint', timeoutMs: 30000, required: false },
        ],
        failOnOptional: true,
      },
    };

    // Verify shape matches ValidationCommand
    const commands: ValidationCommand[] = config.validation.commands;
    expect(commands).toHaveLength(2);
    expect(commands[0].id).toBe('unit-test');
    expect(commands[0].command).toBe('echo pass');
    expect(commands[0].timeoutMs).toBe(5000);
    expect(commands[0].required).toBe(true);
    expect(commands[1].required).toBe(false);
  });

  it('full chain: config → classifyCommand → decidePermission for safe commands', () => {
    const config: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG };

    // All commands allow safe_git (toolName='git', command=['status'])
    const decision = decidePermission({
      toolName: 'git',
      command: ['status'],
      workflowAllowsDestructiveGit: config.destructiveGit.allow,
    });
    expect(decision.outcome).toBe('allow');
  });
});

// ─── T-2: evidence-gate + command-runner pipeline ──────────────
// Verifies that runValidationCommands output correctly feeds into evaluateEvidence

describe('T-2: evidence-gate + command-runner pipeline', () => {
  it('successful command pipeline: runCommands → evaluateEvidence → passed', async () => {
    const commands: ValidationCommand[] = [
      { id: 'echo-test', command: 'echo hello', timeoutMs: 5000, required: true },
    ];

    // Run commands
    const results = await runValidationCommands(commands);

    // Feed to evidence gate
    const evidence = evaluateEvidence({
      commands,
      results,
      diffSummary: '1 file changed',
      now: Date.now(),
    });

    expect(evidence.status).toBe('passed');
    expect(evidence.commands).toHaveLength(1);
    expect(evidence.commands[0].status).toBe('passed');
    expect(evidence.diffSummary).toBe('1 file changed');
  });

  it('failing command pipeline: runCommands → evaluateEvidence → failed', async () => {
    const commands: ValidationCommand[] = [
      { id: 'fail-test', command: 'false', timeoutMs: 5000, required: true },
    ];

    const results = await runValidationCommands(commands);
    const evidence = evaluateEvidence({
      commands,
      results,
      diffSummary: '',
      now: Date.now(),
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.failureReason).toContain('fail-test');
  });

  it('mixed commands pipeline: some pass, required fails → failed', async () => {
    const commands: ValidationCommand[] = [
      { id: 'pass-cmd', command: 'echo ok', timeoutMs: 5000, required: true },
      { id: 'fail-cmd', command: 'false', timeoutMs: 5000, required: true },
    ];

    const results = await runValidationCommands(commands);
    const evidence = evaluateEvidence({
      commands,
      results,
      diffSummary: '2 files changed',
      now: Date.now(),
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.failureReason).toContain('fail-cmd');
  });

  it('optional command failure pipeline: pass + optional fail → passed', async () => {
    const commands: ValidationCommand[] = [
      { id: 'required-cmd', command: 'echo ok', timeoutMs: 5000, required: true },
      { id: 'optional-cmd', command: 'false', timeoutMs: 5000, required: false },
    ];

    const results = await runValidationCommands(commands);
    const evidence = evaluateEvidence({
      commands,
      results,
      diffSummary: '',
      now: Date.now(),
    });

    expect(evidence.status).toBe('passed');
  });

  it('timeout command pipeline: runCommands → evaluateEvidence → failed with timeout', async () => {
    const commands: ValidationCommand[] = [
      { id: 'timeout-cmd', command: `node -e "setTimeout(()=>{},2000)"`, timeoutMs: 50, required: true },
    ];

    const results = await runValidationCommands(commands);
    expect(results[0].status).toBe('timeout');

    const evidence = evaluateEvidence({
      commands,
      results,
      diffSummary: '',
      now: Date.now(),
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.failureReason).toContain('timeout-cmd');
  }, 10000);

  it('empty commands pipeline: no commands → skipped', async () => {
    const commands: ValidationCommand[] = [];
    const results = await runValidationCommands(commands);

    const evidence = evaluateEvidence({
      commands,
      results,
      diffSummary: '',
      now: Date.now(),
    });

    expect(evidence.status).toBe('skipped');
  });
});

// ─── T-3: stall-detector + orchestrator reducer integration ──────────
// Verifies that checkStall output correctly feeds into orchestratorReducer

describe('T-3: stall-detector + orchestrator reducer', () => {
  function makeState(overrides: Partial<AutopilotState> = {}): AutopilotState {
    return {
      sessionKey: 'test-session',
      runId: 'run-1',
      orchestrationState: 'running',
      status: 'running',
      enabled: true,
      goal: 'test goal',
      turnAttempts: 0,
      totalContinuations: 0,
      maxAttemptsPerTurn: 5,
      maxTotalContinuations: 50,
      maxConcurrentAutopilot: 5,
      toolErrorCount: 0,
      toolErrorThreshold: 3,
      needsCrossTurnResume: false,
      totalTokensUsed: 0,
      degraded: false,
      startedAt: 100000,
      lastActivityAt: 100000,
      inputTokensUsed: 0,
      outputTokensUsed: 0,
      ...overrides,
    };
  }

  it('stall detected → stall_timeout event → retry_queued state', () => {
    const state = makeState({ lastActivityAt: 100000 });
    const stallTimeoutMs = 300000;
    const now = 500000; // 400000ms after lastActivity → stalled

    // Step 1: Check stall
    const stallResult = checkStall({
      orchestrationState: state.orchestrationState ?? 'idle',
      lastActivityAt: state.lastActivityAt,
      now,
      stallTimeoutMs,
    });

    expect(stallResult.stalled).toBe(true);

    // Step 2: Dispatch stall_timeout event to orchestrator
    const event: OrchestratorEvent = { type: 'stall_timeout', runId: 'run-1', now };
    const newState = orchestratorReducer(state, event);

    expect(newState.orchestrationState).toBe('retry_queued');
    expect(newState.retry).toBeDefined();
    expect(newState.retry?.attempt).toBe(1);
    expect(newState.lastActivityAt).toBe(now);
  });

  it('stall → retry_queued → retry_due → claimed → running cycle', () => {
    let state = makeState({ lastActivityAt: 100000 });

    // Stall detected at t=500000
    state = orchestratorReducer(state, { type: 'stall_timeout', runId: 'run-1', now: 500000 });
    expect(state.orchestrationState).toBe('retry_queued');

    // Retry is due
    const retryAt = state.retry?.nextRetryAt ?? 0;
    state = orchestratorReducer(state, { type: 'retry_due', runId: 'run-1', now: retryAt + 1 });
    expect(state.orchestrationState).toBe('claimed');

    // Agent turn starts → running
    state = orchestratorReducer(state, { type: 'agent_turn_started', runId: 'run-1', now: retryAt + 10 });
    expect(state.orchestrationState).toBe('running');
  });

  it('repeated stall → max retries → blocked', () => {
    const stallTimeoutMs = 300000;
    let state = makeState({
      lastActivityAt: 100000,
      workflow: { ...DEFAULT_WORKFLOW_CONFIG, maxRetries: 2, maxRetryBackoffMs: 100 },
    });

    // Stall 1: attempt 1 <= maxRetries 2 → retry_queued
    state = orchestratorReducer(state, { type: 'stall_timeout', runId: 'run-1', now: 500000 });
    expect(state.orchestrationState).toBe('retry_queued');
    expect(state.retry?.attempt).toBe(1);

    // Retry 1 → claimed → running
    const retryAt1 = state.retry?.nextRetryAt ?? 0;
    state = orchestratorReducer(state, { type: 'retry_due', runId: 'run-1', now: retryAt1 + 1 });
    state = orchestratorReducer(state, { type: 'agent_turn_started', runId: 'run-1', now: retryAt1 + 10 });
    state = { ...state, lastActivityAt: retryAt1 + 10 };

    // Stall 2: attempt 2 <= maxRetries 2 → retry_queued (not blocked yet)
    const now2 = retryAt1 + 10 + stallTimeoutMs + 1;
    state = orchestratorReducer(state, { type: 'stall_timeout', runId: 'run-1', now: now2 });
    expect(state.orchestrationState).toBe('retry_queued');
    expect(state.retry?.attempt).toBe(2);

    // Retry 2 → claimed → running
    const retryAt2 = state.retry?.nextRetryAt ?? 0;
    state = orchestratorReducer(state, { type: 'retry_due', runId: 'run-1', now: retryAt2 + 1 });
    state = orchestratorReducer(state, { type: 'agent_turn_started', runId: 'run-1', now: retryAt2 + 10 });
    state = { ...state, lastActivityAt: retryAt2 + 10 };

    // Stall 3: attempt 3 > maxRetries 2 → blocked
    const now3 = retryAt2 + 10 + stallTimeoutMs + 1;
    state = orchestratorReducer(state, { type: 'stall_timeout', runId: 'run-1', now: now3 });
    expect(state.orchestrationState).toBe('blocked');
    expect(state.blockedReason).toBe('max_retries_reached');
  });

  it('no stall while not running → stall_timeout ignored', () => {
    const state = makeState({ orchestrationState: 'blocked' });
    const event: OrchestratorEvent = { type: 'stall_timeout', runId: 'run-1', now: 999999 };

    const newState = orchestratorReducer(state, event);
    // State unchanged — stall_timeout only applies when running
    expect(newState.orchestrationState).toBe('blocked');
  });

  it('stall_duration_ms correctly computed and available for telemetry', () => {
    const state = makeState({ lastActivityAt: 100000 });
    const stallTimeoutMs = 300000;
    const now = 500000; // 400000ms after lastActivity

    const stallResult = checkStall({
      orchestrationState: state.orchestrationState ?? 'idle',
      lastActivityAt: state.lastActivityAt,
      now,
      stallTimeoutMs,
    });

    expect(stallResult.stalled).toBe(true);
    // stallDurationMs = elapsed - stallTimeoutMs = (500000-100000) - 300000 = 100000
    expect(stallResult.stallDurationMs).toBe(100000);
  });
});
