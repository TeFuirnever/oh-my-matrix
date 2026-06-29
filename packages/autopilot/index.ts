import { decideContinuation, buildRetryInstruction } from './src/continuation-engine';
import { trackToolError } from './src/tool-error-tracker';
import { checkStall } from './src/stall-detector';
import { buildEffortInjection } from './src/effort-injection';
import { log, warn, error, logWithContext } from './src/logger';
import {
  activate,
  deactivate,
  pause,
  complete,
  resume,
  incrementTurn,
  incrementTotal,
  resetTurnAttempts,
  setGoal,
  isRunStuck,
} from './src/autopilot-state';
import { preserveGoalBeforeCompaction, restoreGoalAfterCompaction, captureGoal } from './src/goal-manager';
import { projectState } from './src/projection';
import { createInitialState, DEFAULT_CONFIG } from './src/types';
import type { AutopilotState, AutopilotConfig, GatewayCtx } from './src/types';
import type { OpenClawPluginApi, PluginJsonValue } from 'openclaw/dist/plugin-sdk/plugin-runtime';
import { orchestratorReducer } from './src/orchestrator';
import { classifyCommand, decidePermissionForEvent, extractCommandSegments } from '@openclaw/permission-policy';
import { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } from './src/workflow-config';
import { evaluateEvidence } from './src/evidence-gate';
import { runValidationCommands } from './src/command-runner';
import { detectValidationCommands } from './src/project-detector';
import { appendAuditEntry, loadRecentAuditEntries } from '@openclaw/permission-policy';
import { statSync } from 'fs';
import { isAbsolute } from 'path';

/**
 * Validate a renderer-supplied workspacePath before storing it as the
 * containment boundary.  Rejects relative paths, non-existent paths, and
 * paths that are not directories (e.g. plain "/" is accepted only if it is
 * an actual directory — which on POSIX it always is — but that edge-case is
 * intentionally left to the WORKFLOW.md destructiveGit.allow gate and is not
 * a new vulnerability introduced by this fix).
 *
 * Returns undefined when the path is invalid so callers fall back to
 * process.cwd() rather than using an untrusted value.
 */
function validateWorkspacePath(p: string | undefined): string | undefined {
  if (!p || !isAbsolute(p)) return undefined;
  try {
    return statSync(p).isDirectory() ? p : undefined;
  } catch {
    return undefined;
  }
}

export const id = 'autopilot';
export const name = 'Autopilot Continuous Mode';
export const version = '2.0.0';

/** GAP-25: Maximum number of concurrent run states before eviction kicks in */
const MAX_RUN_STATES = 50;

/** GAP-26: Health check threshold — sessions inactive for 24h are orphaned */
const ORPHAN_THRESHOLD_MS = 24 * 60 * 60 * 1000;

let stateByRun = new Map<string, AutopilotState>();
let sessionIdToKey = new Map<string, string>();
let sessionKeyToRunId = new Map<string, string>();
let canaryFired = new Set<string>();
let stallInterval: ReturnType<typeof setInterval> | null = null;

/**
 * before_tool_call priority — must be higher than matrixassistant-audit (priority 9).
 * Ensures autopilot audit trail is recorded before audit can short-circuit.
 * @see the host's matrixassistant-audit plugin (AUDIT_HOOK_PRIORITY = 9)
 */
const BEFORE_TOOL_CALL_PRIORITY = 10;

// Cross-plugin coordination with audit plugin — same Node.js process, CommonJS, package-name require.
// Lazy load: if audit plugin absent, autopilot still works (degraded but safe).
let _auditSetMode: ((mode: 'active' | 'monitor' | 'passive') => void) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS lazy import; audit plugin is an optional peer
  const auditPlugin: unknown = require('@openclaw/matrixassistant-audit');
  if (
    typeof auditPlugin === 'object' &&
    auditPlugin !== null &&
    'audit_setMode' in auditPlugin &&
    typeof (auditPlugin as Record<string, unknown>).audit_setMode === 'function'
  ) {
    _auditSetMode = (auditPlugin as Record<string, unknown>).audit_setMode as (mode: 'active' | 'monitor' | 'passive') => void;
  }
} catch {
  warn('[autopilot] audit plugin not loaded — monitor mode coordination unavailable');
}

function setAuditMode(mode: 'active' | 'monitor' | 'passive'): void {
  try {
    _auditSetMode?.(mode);
    log(`[autopilot] audit mode → '${mode}'`);
  } catch (err) {
    warn(`[autopilot] setAuditMode(${mode}) failed (non-fatal): ${err}`);
  }
}

export function _resetForTest(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('_resetForTest must not be called in production');
  }
  stateByRun = new Map();
  sessionIdToKey = new Map();
  sessionKeyToRunId = new Map();
  canaryFired = new Set();
  if (stallInterval) { clearInterval(stallInterval); stallInterval = null; }
}

/** Test-only: inject a mock audit_setMode so the closed-over _auditSetMode reference is replaceable. */
export function _setAuditSetModeForTest(fn: ((mode: 'active' | 'monitor' | 'passive') => void) | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('_setAuditSetModeForTest must not be called in production');
  }
  _auditSetMode = fn;
}

export function _getInternalStateForTest() {
  return {
    stateByRunSize: stateByRun.size,
    sessionIdToKeySize: sessionIdToKey.size,
    sessionKeyToRunIdSize: sessionKeyToRunId.size,
    canaryFiredSize: canaryFired.size,
  };
}

/**
 * Test helper: inject a partial state for a session and immediately run the
 * retry_due check logic, returning the resulting state.
 * Only available in test environments — do NOT call from production code.
 */
export function _triggerRetryCheckForTest(overrides: {
  sessionKey: string;
  orchestrationState: AutopilotState['orchestrationState'];
  retry?: AutopilotState['retry'];
}): AutopilotState | undefined {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('_triggerRetryCheckForTest must not be called in production');
  }
  let runId = sessionKeyToRunId.get(overrides.sessionKey);

  // If no run exists yet, create a synthetic one for testing
  if (!runId) {
    runId = `test-run-${overrides.sessionKey}`;
    sessionKeyToRunId.set(overrides.sessionKey, runId);
  }

  const existing = stateByRun.get(runId);

  // Inject the overridden fields (or create fresh state if no existing run)
  const base: AutopilotState = existing ?? {
    sessionKey: overrides.sessionKey,
    status: 'running',
    enabled: true,
    startedAt: Date.now(),
    totalContinuations: 0,
    turnAttempts: 0,
    totalTokensUsed: 0,
    degraded: false,
    needsCrossTurnResume: false,
  } as AutopilotState;

  const injected: AutopilotState = {
    ...base,
    orchestrationState: overrides.orchestrationState,
    retry: overrides.retry,
    enabled: true,
  };
  setState(runId, injected);

  // Run the same retry_due logic used by the stall interval
  const now = Date.now();
  const state = stateByRun.get(runId)!;
  if (
    state.enabled &&
    state.orchestrationState === 'retry_queued' &&
    state.retry?.nextRetryAt != null &&
    state.retry.nextRetryAt <= now
  ) {
    const updated = orchestratorReducer(state, { type: 'retry_due', runId, now });
    setState(runId, updated);
  }

  return stateByRun.get(runId);
}

/** GAP-25: Evict oldest runs when Map exceeds MAX_RUN_STATES */
function evictOldestRuns(): void {
  while (stateByRun.size > MAX_RUN_STATES) {
    // Find the run with the earliest startedAt (FIFO eviction)
    let oldestRunId: string | null = null;
    let oldestAt = Infinity;
    for (const [runId, state] of stateByRun) {
      if ((state.startedAt ?? Infinity) < oldestAt) {
        oldestAt = state.startedAt ?? Infinity;
        oldestRunId = runId;
      }
    }
    if (oldestRunId == null) break;
    const oldestState = stateByRun.get(oldestRunId);
    stateByRun.delete(oldestRunId);
    if (oldestState) {
      sessionKeyToRunId.delete(oldestState.sessionKey);
      canaryFired.delete(oldestState.sessionKey);
      // GAP-25: also clean up sessionIdToKey to prevent orphaned sid→skey entries
      for (const [sid, skey] of sessionIdToKey) {
        if (skey === oldestState.sessionKey) {
          sessionIdToKey.delete(sid);
          break;
        }
      }
    }
  }
}

function setState(runId: string, state: AutopilotState): void {
  stateByRun.set(runId, state);
  if (stateByRun.size > MAX_RUN_STATES) evictOldestRuns();
}

/** GAP-23: Cleanup all state on shutdown */
function cleanupAll(): void {
  // Release audit monitor refCount for every active run before clearing state.
  // Each run acquired one refCount via setAuditMode('monitor'), so each needs a matching release.
  for (let i = 0; i < stateByRun.size; i++) {
    setAuditMode('active');
  }
  stateByRun.clear();
  sessionIdToKey.clear();
  sessionKeyToRunId.clear();
  canaryFired.clear();
  if (stallInterval) { clearInterval(stallInterval); stallInterval = null; }
}

function findRunBySession(sessionKey: string): [string, AutopilotState] | undefined {
  const runId = sessionKeyToRunId.get(sessionKey);
  if (!runId) return undefined;
  const state = stateByRun.get(runId);
  return state ? [runId, state] : undefined;
}

/** Generate a unique run ID using crypto.randomUUID (exported for testing). */
export function _generateRunIdForTest(): string {
  return `run-${crypto.randomUUID()}`;
}

function generateRunId(): string {
  return _generateRunIdForTest();
}

export function register(api: OpenClawPluginApi): void {
  // Read user config from OpenClaw, merge with defaults
  // pluginConfig is Record<string, unknown> — coerce values to expected types
  const uc = api.pluginConfig ?? {};
  const numOrUndefined = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined;
  const config: AutopilotConfig = {
    ...DEFAULT_CONFIG,
    ...(numOrUndefined(uc.maxAttemptsPerTurn) != null ? { maxAttemptsPerTurn: numOrUndefined(uc.maxAttemptsPerTurn)! } : {}),
    ...(numOrUndefined(uc.maxTotalContinuations) != null ? { maxTotalContinuations: numOrUndefined(uc.maxTotalContinuations)! } : {}),
    ...(numOrUndefined(uc.toolErrorThreshold) != null ? { toolErrorThreshold: numOrUndefined(uc.toolErrorThreshold)! } : {}),
    ...(Array.isArray(uc.excludedAgents) ? { excludedAgents: uc.excludedAgents as string[] } : {}),
    ...(Array.isArray(uc.highRiskTools) ? { highRiskTools: uc.highRiskTools as string[] } : {}),
    ...(numOrUndefined(uc.tokenBudget) != null ? { tokenBudget: numOrUndefined(uc.tokenBudget) } : {}),
    ...(numOrUndefined(uc.maxConcurrentAutopilot) != null ? { maxConcurrentAutopilot: numOrUndefined(uc.maxConcurrentAutopilot)! } : {}),
  };
  log(`[autopilot] config: maxAttemptsPerTurn=${config.maxAttemptsPerTurn} maxTotalContinuations=${config.maxTotalContinuations} toolErrorThreshold=${config.toolErrorThreshold} excludedAgents=${JSON.stringify(config.excludedAgents)} highRiskTools=${JSON.stringify(config.highRiskTools)} tokenBudget=${config.tokenBudget}`);

  // --- Hooks (use api.on for typed hooks when available, registerHook as fallback) ---
  const registerHook = api.on?.bind(api) ?? api.registerHook?.bind(api);
  if (!registerHook) {
    error('[autopilot] hook registration API unavailable (api.on and api.registerHook both missing) — plugin disabled');
    return;
  }

  registerHook('before_agent_finalize', async (event: any) => {
    const sessionKey = event.sessionKey ?? sessionIdToKey.get(event.sessionId);
    if (sessionKey) canaryFired.add(sessionKey);
    if (!sessionKey) return { action: 'continue' };

    const entry = findRunBySession(sessionKey);
    if (!entry) return { action: 'continue' };

    const [runId, rawState] = entry;

    // Fix: clear needsCrossTurnResume at start of new turn triggered by cross-turn resume.
    // Without this, sessions.changed keeps firing with needsCrossTurnResume=true → infinite loop.
    const state = rawState.needsCrossTurnResume
      ? { ...rawState, needsCrossTurnResume: false }
      : rawState;
    if (rawState.needsCrossTurnResume) setState(runId, state);

    const decision = decideContinuation(state, {
      lastAssistantMessage: event.lastAssistantMessage,
      stopHookActive: event.stopHookActive,
    });

    log(`[autopilot] before_agent_finalize: session=${sessionKey} action=${decision.action} turn=${state.turnAttempts}/${state.maxAttemptsPerTurn} total=${state.totalContinuations}/${state.maxTotalContinuations}`);

    switch (decision.action) {
      case 'revise': {
        const updated = incrementTotal(incrementTurn(state));
        setState(runId, updated);
        return {
          action: 'revise',
          retry: {
            instruction: decision.retryInstruction!,
            idempotencyKey: `autopilot-${runId}-${updated.totalContinuations}`,
            maxAttempts: state.maxAttemptsPerTurn - updated.turnAttempts,
          },
        };
      }
      case 'cross_turn': {
        const enqueue = api.session?.workflow?.enqueueNextTurnInjection;
        if (typeof enqueue === 'function') {
          const updated = { ...incrementTotal(state), needsCrossTurnResume: true, turnAttempts: 0 };
          try {
            const result = await enqueue({
              sessionKey,
              text: decision.retryInstruction || 'Continue from where you left off.',
              idempotencyKey: `autopilot-cross-${sessionKey}-${updated.totalContinuations}`,
              placement: 'prepend_context',
              ttlMs: 300000,
            });
            if (result && typeof result === 'object' && result.enqueued === false) {
              warn(`[autopilot] enqueueNextTurnInjection rejected for session=${sessionKey}, falling back to revise`);
              const fallbackState = { ...incrementTotal(state), turnAttempts: 0 };
              setState(runId, fallbackState);
              return {
                action: 'revise',
                retry: {
                  instruction: decision.retryInstruction || 'Continue from where you left off.',
                  idempotencyKey: `autopilot-${runId}-${fallbackState.totalContinuations}`,
                  maxAttempts: fallbackState.maxAttemptsPerTurn,
                },
              };
            }
            setState(runId, updated);
            return { action: 'finalize' };
          } catch (err) {
            warn(`[autopilot] enqueueNextTurnInjection failed for session=${sessionKey}: ${err}, falling back to revise`);
            const fallbackState = { ...incrementTotal(state), turnAttempts: 0 };
            setState(runId, fallbackState);
            return {
              action: 'revise',
              retry: {
                instruction: decision.retryInstruction || '请从上次中断的位置继续执行。',
                idempotencyKey: `autopilot-${runId}-${fallbackState.totalContinuations}`,
                maxAttempts: fallbackState.maxAttemptsPerTurn,
              },
            };
          }
        }
        // Fallback: injection API unavailable, use same-turn revise instead
        const fallbackState = { ...incrementTotal(state), turnAttempts: 0 };
        setState(runId, fallbackState);
        return {
          action: 'revise',
          retry: {
            instruction: decision.retryInstruction || '请从上次中断的位置继续执行。',
            idempotencyKey: `autopilot-${runId}-${fallbackState.totalContinuations}`,
            maxAttempts: fallbackState.maxAttemptsPerTurn,
          },
        };
      }
      case 'pause': {
        setState(runId, pause(state, decision.pauseReason!));
        // Release audit monitor during pause — resume will re-acquire when session continues.
        setAuditMode('active');
        return { action: 'finalize' };
      }
      case 'complete': {
        const now = Date.now();
        // M5: Evidence Gate — evaluate before marking done.
        // M5.3: Execute configured validation commands via child_process.exec before evaluating.
        let evidenceSummary;
        try {
          const evidenceCommands = state.workflow?.validation.commands ?? [];
          const evidenceResults = evidenceCommands.length > 0
            ? await runValidationCommands(evidenceCommands, state.workspace?.path)
            : [];
          evidenceSummary = evaluateEvidence({
            commands: evidenceCommands,
            results: evidenceResults,
            diffSummary: '',
            now,
          });
        } catch (err) {
          // Fail-open: if evidence evaluation throws, treat as skipped to avoid zombie sessions
          warn(`[autopilot] evidence gate error (failing open): ${err} session=${sessionKey}`);
          evidenceSummary = { status: 'skipped' as const, diffSummary: '', commands: [], completedAt: now, failureReason: 'evaluation error' };
        }
        // Dispatch evidence events only when orchestration state machine is active (released state)
        let updated = state;
        if (state.orchestrationState === 'released') {
          updated = orchestratorReducer(state, { type: 'evidence_started', runId, now });
          updated = orchestratorReducer(updated, {
            type: 'evidence_finished',
            runId,
            now,
            evidence: evidenceSummary,
          });
        }
        // Apply evidence to state + mark done.
        // Guard (H1): evidence_finished (passed/skipped) already sets status:'done' via orchestrator.
        // complete() requires status='running' and would throw — skip it when orchestrator completed.
        setState(runId, updated.status === 'done'
          ? { ...updated, evidence: evidenceSummary }
          : complete({ ...updated, evidence: evidenceSummary }));
        logWithContext('info', 'evidence gate result', { sessionKey, runId, evidenceStatus: evidenceSummary.status });
        // Release audit monitor when task completes — session is done, no more tool calls needed.
        setAuditMode('active');
        return { action: 'finalize' };
      }
      default:
        return { action: 'continue' };
    }
  });

  registerHook('after_tool_call', (event: any) => {
    const sessionKey = event.sessionKey ?? sessionIdToKey.get(event.sessionId);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (!entry?.[1].enabled) return;
    const [runId, state] = entry;

    // B-1: dispatch tool_result activity so stall detector resets lastActivityAt.
    // Merge with error tracking into one setState to avoid double subscriber firing.
    const afterActivity = orchestratorReducer(state, {
      type: 'agent_activity',
      runId,
      activity: 'tool_result',
      now: Date.now(),
    });

    if (!event.error) {
      setState(runId, afterActivity);
      return;
    }
    const withError = trackToolError(afterActivity, {
      tool: event.toolName,
      args: JSON.stringify(event.params ?? {}).substring(0, 200),
      error: (event.error ?? '').substring(0, 200),
    });
    setState(runId, withError);
    log(`[autopilot] after_tool_call error: session=${sessionKey} tool=${event.toolName} errCount=${withError.toolErrorCount}/${state.toolErrorThreshold}`);
  });

  registerHook('before_compaction', (event: any) => {
    const sessionKey = event.sessionKey ?? sessionIdToKey.get(event.sessionId);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (entry?.[1].enabled) {
      log(`[autopilot] before_compaction: session=${sessionKey} preserving goal`);
      setState(entry[0], preserveGoalBeforeCompaction(entry[1]));
    }
  });

  registerHook('after_compaction', (event: any) => {
    const sessionKey = event.sessionKey ?? sessionIdToKey.get(event.sessionId);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (entry?.[1].enabled) {
      log(`[autopilot] after_compaction: session=${sessionKey} restoring goal`);
      setState(entry[0], restoreGoalAfterCompaction(entry[1]));
    }
  });

  registerHook('agent_turn_prepare', (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey ?? event.sessionKey;
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (!entry?.[1].enabled) return;

    const [runId, state] = entry;
    let updated = state;

    // Phase 1: Dispatch agent_turn_started through orchestrator reducer
    updated = orchestratorReducer(updated, {
      type: 'agent_turn_started',
      runId,
      now: Date.now(),
    });

    // Capture goal from first user prompt if not already set
    if (!updated.goal && event.prompt) {
      updated = captureGoal(updated, event.prompt);
      if (updated.goal) {
        setState(runId, updated);
        log(`[autopilot] agent_turn_prepare: captured goal "${updated.goal.substring(0, 80)}"`);
      }
    }

    // Skip injection right after compaction (compaction hooks handle it).
    // Escape hatch: if goalSnapshot is set but goal exists, the snapshot is stale
    // (after_compaction never fired after before_compaction). Clear it to unblock injection.
    if (updated.goalSnapshot) {
      if (updated.goal) {
        updated = { ...updated, goalSnapshot: undefined, progressSnapshot: undefined };
        setState(runId, updated);
        warn(`[autopilot] agent_turn_prepare: cleared stale goalSnapshot for session=${sessionKey}`);
      } else {
        return;
      }
    }

    // Inject goal reinforcement
    const parts: string[] = [];
    // Agent-facing context injections — not user-visible, intentionally bypass i18n.
    // English used for consistent model comprehension regardless of UI language.
    if (updated.goal) {
      parts.push(`[Autopilot] Current goal: ${updated.goal}`);
    }
    if (updated.progress) {
      parts.push(`[Autopilot] Progress so far: ${updated.progress}`);
    }

    if (parts.length === 0) return;

    // Effort injection: ensure high effort for every autopilot turn (TD-1)
    const effortCtx = buildEffortInjection(updated.status);
    if (effortCtx) parts.push(effortCtx);

    // Completion awareness instruction
    parts.push('[Autopilot] When all tasks are complete, explicitly state "All tasks completed".');

    return { appendContext: parts.join('\n') };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHook('before_agent_run', (_event: any, ctx: any): any => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return { outcome: 'pass' as const };
    const entry = findRunBySession(sessionKey);
    if (!entry?.[1].enabled) return { outcome: 'pass' as const };

    const agentId = ctx?.agentId;
    if (agentId && config.excludedAgents?.includes(agentId)) {
      log(`[autopilot] before_agent_run: blocked agent=${agentId} session=${sessionKey} (excluded)`);
      return {
        outcome: 'block' as const,
        reason: `autopilot excluded agent: ${agentId}`,
        message: `Autopilot mode is not allowed on agent "${agentId}"`,
      };
    }

    return { outcome: 'pass' as const };
  });

  registerHook('before_tool_call', (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);

    if (!entry?.[1].enabled) return;

    const [runId, state] = entry;
    const toolName = event.toolName as string;

    // B-1: dispatch tool_call activity so stall detector resets lastActivityAt.
    // Use withActivity as base for all subsequent setState calls to preserve lastActivityAt.
    const withActivity = orchestratorReducer(state, {
      type: 'agent_activity',
      runId,
      activity: 'tool_call',
      now: Date.now(),
    });

    // Real OpenClaw event: {toolName, params:{command?, workdir?}, runId, toolCallId}.
    // NO event.args / event.toolKind / event.cwd (verified live 2026-06-28). Command
    // lives in params.command; cwd in params.workdir.
    const { cwd: eventCwd } = extractCommandSegments(event);
    const isConfiguredHighRisk = Array.isArray(config.highRiskTools) && config.highRiskTools.includes(toolName);
    const decision = isConfiguredHighRisk
      ? ({ outcome: 'block' as const, reason: `${toolName} is configured as high-risk tool`, message: `Tool "${toolName}" is blocked by operator config (highRiskTools)` })
      : decidePermissionForEvent(event, {
          cwd: eventCwd ?? state.workspace?.path ?? process.cwd(),
          workspacePath: state.workspace?.path,
          workspaceRoot: state.workspace?.root ?? process.cwd(),
          workflowAllowsDestructiveGit: state.workflow?.destructiveGit?.allow ?? false,
          // trusted autopilot run-scoped: keep allow-by-default (no defaultDeny)
        });

    // GAP-9: Log every tool call to permission audit trail (cap at 200 entries)
    const commandClass = decision.commandClass ?? classifyCommand(toolName);
    const auditEntry: import('./src/types').PermissionAuditEntry = {
      at: Date.now(),
      runId,
      toolName,
      commandClass,
      outcome: decision.outcome as 'allow' | 'require_approval' | 'block',
      reason: decision.reason,
    };
    const MAX_AUDIT = 200;
    const prevAudit = withActivity.permissionAudit ?? [];
    const nextAudit = prevAudit.length >= MAX_AUDIT
      ? [...prevAudit.slice(-(MAX_AUDIT - 1)), auditEntry]
      : [...prevAudit, auditEntry];
    setState(runId, {
      ...withActivity,
      permissionAudit: nextAudit,
    });
    // Persist audit entry to disk (fail-silent)
    appendAuditEntry(auditEntry, state.workspace?.path ?? process.cwd());

    if (decision.outcome === 'allow') return;

    // Block: hard veto — gateway honors hookResult.block directly (line 995 of
    // agent-tools.before-tool-call), bypassing plugin.approval.* channel entirely.
    // Using requireApproval+timeoutMs:1 was broken — it still walked the approval
    // pipeline which has no handler, causing 10s+ "Approval timed out" errors.
    if (decision.outcome === 'block') {
      logWithContext('info', 'before_tool_call BLOCKED', { sessionKey, runId, toolName, reason: decision.reason });
      return {
        block: true,
        blockReason: (decision as { outcome: 'block'; reason: string; message: string }).message,
      };
    }
  }, { priority: BEFORE_TOOL_CALL_PRIORITY });

  registerHook('llm_output', (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (!entry?.[1].enabled) return;

    const usage = event.usage;
    if (!usage?.total) return;

    // H4: Guard against NaN / negative / non-finite token counts
    const added = typeof usage.total === 'number' && Number.isFinite(usage.total) && usage.total >= 0
      ? usage.total : 0;

    const [runId, state] = entry;
    let updated = { ...state, totalTokensUsed: state.totalTokensUsed + added };
    // Phase 1: Dispatch agent_activity through orchestrator reducer
    // Note: inputTokensUsed/outputTokensUsed are updated by the reducer's agent_activity case
    updated = orchestratorReducer(updated, {
      type: 'agent_activity',
      runId,
      activity: 'llm_output',
      now: Date.now(),
      tokens: { input: usage.input, output: usage.output, total: added },
    });
    setState(runId, updated);
    log(`[autopilot] llm_output: session=${sessionKey} tokens=+${added} total=${updated.totalTokensUsed}${updated.tokenBudget ? `/${updated.tokenBudget}` : ''}`);
  });

  registerHook('session_start', (event: any) => {
    if (event.sessionId && event.sessionKey) {
      sessionIdToKey.set(event.sessionId, event.sessionKey);
      log(`[autopilot] session_start: ${event.sessionId} → ${event.sessionKey}`);
    }
  });

  registerHook('session_end', (event: any) => {
    const sessionKey = event.sessionKey ?? sessionIdToKey.get(event.sessionId);
    sessionIdToKey.delete(event.sessionId);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (entry) {
      const [runId] = entry;
      stateByRun.delete(runId);
      sessionKeyToRunId.delete(sessionKey);
      canaryFired.delete(sessionKey);
    }
    log(`[autopilot] session_end: session=${sessionKey} state cleaned up`);
  });

  registerHook('agent_end', async (event: any) => {
    const sessionKey = event.sessionKey ?? sessionIdToKey.get(event.sessionId);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (!entry) return;
    if (!entry[1].enabled) return;
    const [runId, state] = entry;

    const didFire = canaryFired.has(sessionKey);
    canaryFired.delete(sessionKey);

    if (!didFire) {
      const updated = { ...state, degraded: true };
      // M-4: When at max continuations, pause directly instead of requesting cross-turn
      // (cross-turn would just hit max_total_reached again — wasted IPC round-trip)
      if (state.status === 'running' && state.totalContinuations >= state.maxTotalContinuations) {
        setState(runId, pause(updated, 'max_total_reached'));
        warn(`[autopilot] agent_end: degraded at max continuations, pausing session=${sessionKey}`);
        return;
      }
      if (state.status === 'running' && state.totalContinuations < state.maxTotalContinuations) {
        const continued = incrementTotal(resetTurnAttempts(updated));
        const enqueue = api.session?.workflow?.enqueueNextTurnInjection;
        if (typeof enqueue === 'function') {
          try {
            const injectResult = await enqueue({
              sessionKey,
              text: buildRetryInstruction(continued),
              idempotencyKey: `autopilot-degraded-${sessionKey}-${continued.totalContinuations}`,
              placement: 'prepend_context',
              ttlMs: 300000,
            });
            if (injectResult && typeof injectResult === 'object' && injectResult.enqueued === false) {
              warn(`[autopilot] agent_end: degraded fallback enqueue rejected for session=${sessionKey}`);
            } else {
              // H-1: Merge cross-turn fields onto current state (preserves intermediate changes)
              const current = stateByRun.get(runId);
              if (current) {
                setState(runId, {
                  ...current,
                  totalContinuations: current.totalContinuations + 1,
                  needsCrossTurnResume: true,
                  turnAttempts: 0,
                  degraded: true,
                });
              } else {
                setState(runId, continued);
              }
              warn(`[autopilot] agent_end: degraded fallback cross-turn for session=${sessionKey}`);
              return;
            }
          } catch (err) {
            warn(`[autopilot] agent_end: degraded fallback injection failed: ${err}`);
          }
        }
      }
      setState(runId, { ...updated, needsCrossTurnResume: true });
      warn(`[autopilot] agent_end: canary check failed for session=${sessionKey} — before_agent_finalize never fired, hook may be disabled`);
      return;
    }

    const isBreaker = !event.success && event.error?.toLowerCase().includes('circuit breaker');
    const afterPause = isBreaker ? pause(state, 'loop_breaker_triggered') : state;
    // GAP-24: Clear degraded when canary fired — system recovered from degradation
    const afterDegradedClear = didFire ? { ...afterPause, degraded: false } : afterPause;
    // Phase 1: Dispatch agent_turn_finished through orchestrator reducer
    const afterOrchestrator = orchestratorReducer(resetTurnAttempts(afterDegradedClear), {
      type: 'agent_turn_finished',
      runId,
      success: event.success !== false,
      error: event.error,
      now: Date.now(),
    });
    // GAP-8: Write progress after each agent turn
    const afterProgress: AutopilotState = {
      ...afterOrchestrator,
      progress: `Turn ${afterOrchestrator.totalContinuations}/${afterOrchestrator.maxTotalContinuations} completed`,
    };
    setState(runId, afterProgress);
    logWithContext('info', 'agent_end', { sessionKey, runId, success: event.success, isBreaker, orchState: afterProgress.orchestrationState ?? 'n/a', progress: afterProgress.progress });
  });

  // --- Session Extension ---
  const registerSessionExt = api.session?.state?.registerSessionExtension;
  if (typeof registerSessionExt !== 'function') {
    error('[autopilot] registerSessionExtension API unavailable — session extension not registered, toggle will use default idle state');
  } else {
  registerSessionExt({
    namespace: 'autopilot',
    description: 'Autopilot continuous mode state projection',
    sessionEntrySlotKey: 'autopilot',
    project: (ctx) => {
      if (!ctx.sessionKey) return undefined;
      const entry = findRunBySession(ctx.sessionKey);
      if (entry) return projectState(entry[1]) as unknown as PluginJsonValue;
      return {
        status: 'idle' as const,
        enabled: false,
        turnAttempts: 0,
        totalContinuations: 0,
        maxAttemptsPerTurn: config.maxAttemptsPerTurn,
        maxTotalContinuations: config.maxTotalContinuations,
        maxConcurrentAutopilot: config.maxConcurrentAutopilot ?? 5,
        needsCrossTurnResume: false,
        canStop: false,
        totalTokensUsed: 0,
        degraded: false,
      } as unknown as PluginJsonValue;
    },
    cleanup: (ctx) => {
      if (ctx.sessionKey) {
        const entry = findRunBySession(ctx.sessionKey);
        if (entry) stateByRun.delete(entry[0]);
      }
    },
  });
  }

  // --- Gateway Methods (OpenClaw-native session-level operations) ---
  if (typeof api.registerGatewayMethod !== 'function') {
    error('[autopilot] registerGatewayMethod API unavailable — gateway methods not registered');
  } else {

  api.registerGatewayMethod('autopilot.activate', async ({ params: ctx, respond }: GatewayCtx) => {
      const sessionKey = ctx.sessionKey as string | undefined;
      log('[autopilot] activate called — sessionKey:', sessionKey, 'params:', JSON.stringify(ctx));
      if (!sessionKey) { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'missing sessionKey' }); return; }

      // GAP-7: Extract payload fields from RPC call (sent by AutopilotCreateDialog)
      const payloadGoal: string | undefined = ctx.goal as string | undefined;
      const payloadMaxContinuations: number | undefined = ctx.maxTotalContinuations as number | undefined;
      const payloadWorkspacePath = validateWorkspacePath(ctx.workspacePath as string | undefined);
      const payloadTokenBudget: number | undefined =
        typeof ctx.tokenBudget === 'number' && ctx.tokenBudget > 0 ? ctx.tokenBudget : undefined;

      // Concurrency guard: count sessions with status === 'running'
      const maxConcurrent = config.maxConcurrentAutopilot ?? 5;
      const runningCount = Array.from(stateByRun.values()).filter(s => s.status === 'running').length;
      // Only enforce if the current session is NOT already running (re-activating an existing running session is handled below)
      const currentEntry = findRunBySession(sessionKey);
      const currentlyRunning = currentEntry?.[1].status === 'running';
      if (!currentlyRunning && runningCount >= maxConcurrent) {
        warn(`[autopilot] activate rejected: max_concurrent_reached (running=${runningCount} max=${maxConcurrent})`);
        respond(false, undefined, { code: 'INVALID_REQUEST', message: 'max_concurrent_reached' });
        return;
      }

      /** Apply payload overrides to state (GAP-7 wiring) */
      const applyPayload = (s: AutopilotState): AutopilotState => {
        const next = { ...s };
        if (payloadMaxContinuations != null) next.maxTotalContinuations = Math.min(500, Math.max(1, Math.round(payloadMaxContinuations)));
        if (payloadTokenBudget != null) next.tokenBudget = payloadTokenBudget;
        return next;
      };

      // GAP-6: Load workflow config from WORKFLOW.md
      const applyWorkflowConfig = (s: AutopilotState): AutopilotState => {
        try {
          // Use payloadWorkspacePath (validated in outer scope by validateWorkspacePath) rather than
          // re-reading ctx.workspacePath raw — prevents path-traversal via WORKFLOW.md loading.
          const result = loadWorkflowConfig(process.cwd(), payloadWorkspacePath);
          // R-3: Auto-fill validation commands when WORKFLOW.md has none.
          // Only auto-detect when an explicit workspace path is provided (not cwd fallback)
          // to avoid running project tests in unexpected directories during tests/CI.
          const autoCommands = result.config.validation.commands.length === 0 && payloadWorkspacePath
            ? detectValidationCommands(payloadWorkspacePath)
            : result.config.validation.commands;
          return {
            ...s,
            workflow: {
              ...result.config,
              validation: { ...result.config.validation, commands: autoCommands },
            },
            maxTotalContinuations: s.maxTotalContinuations,
          };
        } catch (err) {
          // Graceful fallback — use defaults
          return {
            ...s,
            workflow: { ...DEFAULT_WORKFLOW_CONFIG },
            workflowConfigError: err instanceof Error ? err.message : String(err),
          };
        }
      };

      if (currentEntry) {
        const [oldRunId, state] = currentEntry;
        // Allow re-activation from idle/done, OR from a STUCK running session
        // (stalled — orchState=retry_queued or no activity beyond stallTimeout).
        // A stuck run would otherwise block every future activation until a
        // gateway restart, because the stall handler leaves status='running'.
        // Genuinely-active runs (recent activity) still fall through to reject.
        const stuckRecovery = isRunStuck(state, Date.now(), config.tokenBudget ? 300_000 : 600_000);
        if (state.status === 'idle' || state.status === 'done' || stuckRecovery) {
          if (stuckRecovery) {
            warn(`[autopilot] activate: recovering stuck session=${sessionKey} (status=${state.status}, orchState=${state.orchestrationState ?? 'none'}) — discarding stale run ${oldRunId}`);
          }
          // Release audit monitor for the old run before discarding it.
          setAuditMode('active');
          stateByRun.delete(oldRunId);
          sessionKeyToRunId.delete(sessionKey);
          const runId = generateRunId();
          let newState = activate(createInitialState(sessionKey, runId, config));
          // Preserve existing goal only if no new goal provided in payload
          const goalForEvent = payloadGoal ?? state.goal ?? newState.goal;
          newState = orchestratorReducer(newState, { type: 'activate_requested', sessionKey, goal: goalForEvent, now: Date.now() });
          newState = applyPayload(newState);
          newState = applyWorkflowConfig(newState);
          newState = orchestratorReducer(newState, {
            type: 'workspace_ready',
            runId,
            workspace: { root: payloadWorkspacePath ?? process.cwd(), path: payloadWorkspacePath ?? process.cwd(), workspaceKey: runId, branchName: '', baseBranch: 'HEAD', createdNow: false, reusable: true },
            now: Date.now(),
          });
          setState(runId, newState);
          sessionKeyToRunId.set(sessionKey, runId);
          log(`[autopilot] activate: session=${sessionKey} new run=${runId} (was ${state.status}, goal=${goalForEvent ?? 'none'})`);
        } else {
          warn(`[autopilot] activate rejected: session=${sessionKey} status=${state.status}`);
          respond(false, undefined, { code: 'INVALID_REQUEST', message: `cannot activate from status "${state.status}", must be "idle" or "done"` });
          return;
        }
      } else {
        const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
        let state = activate(createInitialState(sessionKey, runId, config));
        state = orchestratorReducer(state, { type: 'activate_requested', sessionKey, goal: payloadGoal, now: Date.now() });
        state = applyPayload(state);
        state = applyWorkflowConfig(state);
        state = orchestratorReducer(state, {
          type: 'workspace_ready',
          runId,
          workspace: { root: payloadWorkspacePath ?? process.cwd(), path: payloadWorkspacePath ?? process.cwd(), workspaceKey: runId, branchName: '', baseBranch: 'HEAD', createdNow: false, reusable: true },
          now: Date.now(),
        });
        setState(runId, state);
        sessionKeyToRunId.set(sessionKey, runId);
        log(`[autopilot] activate: session=${sessionKey} new run=${runId} (goal=${payloadGoal ?? 'none'})`);
      }

      // Suppress audit confirm dialogs for all autopilot sessions.
      setAuditMode('monitor');

      log('[autopilot] activate success — sessionKey:', sessionKey);
      respond(true, { ok: true });
  });

  api.registerGatewayMethod('autopilot.resume', async ({ params: ctx, respond }: GatewayCtx) => {
      const sessionKey = ctx.sessionKey as string | undefined;
      if (!sessionKey) { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'missing sessionKey' }); return; }

      const entry = findRunBySession(sessionKey);
      if (!entry) { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'no active run for session' }); return; }

      const [runId, state] = entry;
      if (state.status !== 'paused') { respond(false, undefined, { code: 'INVALID_REQUEST', message: `cannot resume from status "${state.status}"` }); return; }

      // M2: Dispatch resume_requested through orchestrator reducer
      const orchestrated = orchestratorReducer(state, { type: 'resume_requested', runId, now: Date.now() });
      setState(runId, resume(orchestrated));
      log(`[autopilot] resume: session=${sessionKey} paused→running, errors reset`);
      // Re-acquire audit monitor mode on resume.
      setAuditMode('monitor');
      respond(true, { ok: true });
  });

  api.registerGatewayMethod('autopilot.stop', async ({ params: ctx, respond }: GatewayCtx) => {
      const sessionKey = ctx.sessionKey as string | undefined;
      if (!sessionKey) { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'missing sessionKey' }); return; }

      const entry = findRunBySession(sessionKey);
      if (!entry) { respond(true, { ok: true }); return; }

      const [runId, state] = entry;
      if (state.status === 'running' || state.status === 'paused' || state.status === 'done') {
        // M2: Dispatch stop_requested through orchestrator reducer for M2 state tracking
        const orchestrated = orchestratorReducer(state, { type: 'stop_requested', runId, now: Date.now() });
        setState(runId, deactivate(orchestrated));
        log(`[autopilot] stop: session=${sessionKey} ${state.status}→idle`);
      }
      // Release audit monitor refcount when session stops.
      setAuditMode('active');
      respond(true, { ok: true });
  });

  api.registerGatewayMethod('autopilot.status', async ({ params: ctx, respond }: GatewayCtx) => {
      const sessionKey = ctx.sessionKey as string | undefined;
      const entry = sessionKey ? findRunBySession(sessionKey) : undefined;
      const projection = entry ? projectState(entry[1]) : undefined;
      // Also expose raw state fields not in projection (progress, permissionAudit)
      const state = entry ? entry[1] : undefined;
      respond(true, {
        projection,
        progress: state?.progress,
        // Merge in-memory entries with persisted entries; in-memory takes precedence
        permissionAudit: state?.permissionAudit?.length
          ? state.permissionAudit
          : loadRecentAuditEntries(state?.workspace?.path ?? process.cwd(), 200),
        workflow: state?.workflow,
        workflowConfigError: state?.workflowConfigError,
      });
  });

  api.registerGatewayMethod('autopilot.setGoal', async ({ params: ctx, respond }: GatewayCtx) => {
      const sessionKey = ctx.sessionKey as string | undefined;
      const goal = ctx.goal as string | undefined;
      if (!sessionKey) { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'missing sessionKey' }); return; }
      if (typeof goal !== 'string' || !goal.trim()) { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'goal must be a non-empty string' }); return; }

      const entry = findRunBySession(sessionKey);
      if (!entry) { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'no active run for session' }); return; }

      const [runId, state] = entry;
      setState(runId, setGoal(state, goal));
      log(`[autopilot] setGoal: session=${sessionKey} goal="${goal.substring(0, 80)}"`);
      respond(true, { ok: true });
  });

  // GAP-23: Cleanup action for graceful shutdown
  api.registerGatewayMethod('autopilot.cleanup', async ({ respond }: GatewayCtx) => {
      cleanupAll(); // releases audit monitor for all full_yolo sessions internally
      log('[autopilot] cleanup: all state cleared');
      respond(true, { ok: true });
  });

  }

  // ─── Phase 2: Stall Detection (GAP-4) ───────────────────────────
  // Periodically check all active runs for stall (no activity for stallTimeoutMs).
  // When a stall is detected, dispatch stall_timeout through the orchestrator reducer.
  const stallCheckIntervalMs = 60_000; // Check every 60 seconds
  const stallTimeoutMs = config.tokenBudget ? 300_000 : 600_000; // 5min or 10min default

  // M-7: Clear previous interval before creating new one (HMR / double-register safety)
  if (stallInterval) { clearInterval(stallInterval); stallInterval = null; }

  stallInterval = setInterval(() => {
    const now = Date.now();
    const orphanRunIds: string[] = [];

    for (const [runId, state] of stateByRun.entries()) {
      // GAP-4: Stall detection for active runs
      if (state.enabled && state.status === 'running' && state.orchestrationState === 'running') {
        const stallResult = checkStall({
          lastActivityAt: state.lastActivityAt ?? state.startedAt ?? now,
          now,
          stallTimeoutMs,
          orchestrationState: state.orchestrationState,
        });

        if (stallResult.stalled) {
          const updated = orchestratorReducer(state, {
            type: 'stall_timeout',
            runId,
            now,
          });
          setState(runId, updated);
          warn(`[autopilot] stall detected: session=${state.sessionKey} run=${runId} lastActivity=${stallResult.stallDurationMs ?? 0}ms stall, orchState=${updated.orchestrationState}`);
        }
      }

      // Auto-retry: dispatch retry_due when backoff period expires for retry_queued runs
      if (state.enabled && state.orchestrationState === 'retry_queued' &&
          state.retry?.nextRetryAt != null && state.retry.nextRetryAt <= now) {
        const updated = orchestratorReducer(state, {
          type: 'retry_due',
          runId,
          now,
        });
        setState(runId, updated);
        log(`[autopilot] retry_due: session=${state.sessionKey} run=${runId} attempt=${state.retry?.attempt ?? 1}`);
      }

      // GAP-26: Health check — detect orphaned sessions (no activity for 24h)
      const lastActivity = state.lastActivityAt ?? state.startedAt ?? 0;
      if (lastActivity > 0 && (now - lastActivity) > ORPHAN_THRESHOLD_MS) {
        orphanRunIds.push(runId);
      }
    }

    // Clean up orphaned sessions
    for (const runId of orphanRunIds) {
      const state = stateByRun.get(runId);
      if (state) {
        warn(`[autopilot] health check: cleaning orphaned session=${state.sessionKey} run=${runId}`);
        stateByRun.delete(runId);
        sessionKeyToRunId.delete(state.sessionKey);
        canaryFired.delete(state.sessionKey);
      }
    }
  }, stallCheckIntervalMs);
}
