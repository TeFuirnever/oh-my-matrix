import { decideContinuation, buildRetryInstruction } from './src/continuation-engine';
import { trackToolError } from './src/tool-error-tracker';
import { checkStall } from './src/stall-detector';
import { buildEffortInjection, resolveThinkingIntensity } from './src/effort-injection';
import { resolveModelTier, resolveModelId, isSubagentSession, parseModelRouting, extractParentSessionKey } from './src/model-routing';
import { log, warn, error, logWithContext } from './src/logger';
import {
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
import type { OpenClawPluginApi, PluginJsonValue, PluginHookBeforeAgentFinalizeEvent, PluginHookAfterToolCallEvent, PluginHookBeforeCompactionEvent, PluginHookAfterCompactionEvent, PluginAgentTurnPrepareEvent, PluginHookBeforeModelResolveEvent, PluginHookBeforeAgentRunEvent, PluginHookBeforeToolCallEvent, PluginHookLlmOutputEvent, PluginHookSessionStartEvent, PluginHookSessionEndEvent, PluginHookAgentEndEvent, PluginHookAgentContext } from 'openclaw/dist/plugin-sdk/plugin-runtime';
import { orchestratorReducer } from './src/orchestrator';
import { classifyCommand, decidePermissionForEvent, extractCommandSegments } from '@oh-my-matrix/permission-policy';
import { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } from './src/workflow-config';
import { evaluateEvidence } from './src/evidence-gate';
import { runValidationCommands } from './src/command-runner';
import { detectValidationCommands } from './src/project-detector';
import { appendAuditEntry, loadRecentAuditEntries } from '@oh-my-matrix/permission-policy';
import { statSync } from 'fs';
import { isAbsolute } from 'path';
import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  lookupRunIdBySessionKey,
  listResumableCheckpoints,
  clearSessionIndexEntry,
  getCheckpointRoot,
  migrateLegacyCheckpoints,
  _disableCheckpointingForTest,
  _setCheckpointRootForTest,
} from './src/state-persister';

// Public re-export so consumers import AutopilotProjection from the package
// barrel (@oh-my-matrix/autopilot), not the deep dist/src/projection path.
// See docs/roadmap.md (P2: Autopilot Release Readiness).
export type { AutopilotProjection } from './src/projection';

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
// S14 (audit 2026-06-30): keep in sync with package.json + openclaw.plugin.json.
// These three are the release-time single source of truth for the plugin version.
// Kept aligned automatically by scripts/sync-plugin-versions.cjs (do not hand-edit
// without also updating package.json — the sync script rewrites this line).
export const version = '3.1.0';

/** GAP-25: Maximum number of concurrent run states before eviction kicks in */
const MAX_RUN_STATES = 50;

/** GAP-26: Health check threshold — sessions inactive for 24h are orphaned */
const ORPHAN_THRESHOLD_MS = 24 * 60 * 60 * 1000;

let stateByRun = new Map<string, AutopilotState>();
let sessionIdToKey = new Map<string, string>();
let sessionKeyToRunId = new Map<string, string>();
let canaryFired = new Set<string>();
// S10: one-shot "host not reporting usage" warn per session — avoids log spam
// while making the silent tokenBudget no-op observable to operators.
let noUsageWarned = new Set<string>();
let stallInterval: ReturnType<typeof setInterval> | null = null;

/**
 * PROD-7 / LOGIC-4 actuator handle. The stall interval and the retry-check test
 * helper run OUTSIDE the register() closure that owns `api`, so they cannot read
 * `api.session.workflow.enqueueNextTurnInjection` directly. We stash it at module
 * scope on register() so both paths can kick a new agent turn via kickResumedTurn.
 */
type EnqueueInjectionFn = (injection: {
  sessionKey: string;
  text: string;
  idempotencyKey: string;
  placement?: string;
  ttlMs?: number;
}) => Promise<{ enqueued?: boolean } | void>;
let enqueueInjectionFn: EnqueueInjectionFn | undefined;

/**
 * PROD-7 / LOGIC-4: actuator for stall / programmatic-resume recovery. The
 * reducer moves a run to `claimed` (retry_due or resume_requested) and marks
 * needsCrossTurnResume, but a claimed run cannot start an agent turn on its own —
 * the host only fires agent_turn_prepare when it dispatches a turn. For a
 * genuinely dead agent (stall) or a gateway resume with no follow-up user
 * message, no turn ever comes, so the run would sit in `claimed` until the 24h
 * orphan sweep. This kicks a cross-turn injection so the host actually restarts
 * execution. idempotencyKey (keyed on lastActivityAt) dedupes double-injection
 * of the same recovery event while allowing successive retries to each fire.
 */
function kickResumedTurn(runId: string, state: AutopilotState): void {
  if (state.orchestrationState !== 'claimed') return;
  const enqueue = enqueueInjectionFn;
  if (typeof enqueue !== 'function') return;
  void Promise.resolve(
    enqueue({
      sessionKey: state.sessionKey,
      text: buildRetryInstruction(state),
      idempotencyKey: `autopilot-resume-${runId}-${state.lastActivityAt ?? state.totalContinuations}`,
      placement: 'prepend_context',
      // REV-2 fix: match the stall timeout, not the raw default. A no-budget run
      // stalls at ×2 (600s); the injection TTL must outlive it or the host boots
      // a resumed turn after the injection already expired.
      ttlMs: state.workflow?.stallTimeoutMs ?? defaultStallTimeoutMs(!!state.tokenBudget),
    }),
  ).catch((err) => warn(`[autopilot] resume kick enqueue failed for session=${state.sessionKey}: ${err}`));
}

/**
 * L3: resolve the stall timeout fallback when a run has no per-run config.
 * Runs without a token budget get double the default (undocumented ops tuning —
 * no-budget runs tend to be long-running and tolerate longer silence before
 * being declared stalled). Extracted to a named helper so the ×2 rationale is
 * documented in one place, not duplicated at two call sites.
 */
function defaultStallTimeoutMs(hasTokenBudget: boolean): number {
  return hasTokenBudget
    ? DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs
    : DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs * 2;
}

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
  noUsageWarned = new Set();
  enqueueInjectionFn = undefined;
  // Test isolation: disable checkpoint persistence so the existing 50+ test suite
  // (which calls register() in the repo root and would otherwise both WRITE
  // checkpoints to disk AND load them back on the next test's register()) doesn't
  // cross-contaminate stateByRun. Tests that exercise persistence explicitly
  // re-enable it via _enableCheckpointingForTest().
  _disableCheckpointingForTest();
  if (stallInterval) { clearInterval(stallInterval); stallInterval = null; }
}

// E1/P0-2: checkpoint root is a fixed user-level location (getCheckpointRoot),
// decoupled from the run's workspace — see state-persister.ts. Callers below
// all pass getCheckpointRoot(); the run's workspace is persisted ON the
// checkpoint (containment boundary), only the FILE LOCATION is decoupled.

/**
 * Decide whether a state transition should trigger a checkpoint write. We write
 * only at STABLE POINTS — orchestrationState / blockedReason / evidence status
 * changes — not on every setState (agent_activity fires per token batch and
 * would drown the disk). This is the Review #5 "transition filter, not signature
 * hash" recommendation: 3-line field comparison, no debouncing complexity.
 */
export function shouldCheckpoint(prev: AutopilotState | undefined, next: AutopilotState): boolean {
  if (!prev) return true; // first write for a run — persist immediately
  if (prev.orchestrationState !== next.orchestrationState) return true;
  if (prev.blockedReason !== next.blockedReason) return true;
  if (prev.evidence?.status !== next.evidence?.status) return true;
  if (prev.enabled !== next.enabled) return true;
  // E8 / P3-20: turn-count changes must persist directly, not piggyback on a
  // `progress` string change (fragile — a turn with no progress shift would be lost).
  if (prev.totalContinuations !== next.totalContinuations) return true;
  // Reviewer #1 Finding 5a fix: goal/progress changes (via setGoal gateway RPC)
  // must reach disk, else crash-resume continues toward a stale goal.
  if (prev.goal !== next.goal) return true;
  if (prev.progress !== next.progress) return true;
  return false;
}

/**
 * Checkpoint + terminal-state cleanup hook. Called from setState after a
 * transition-worthy change. Handles:
 *   - persisting the slim checkpoint (fail-silent, per-runId locked)
 *   - deleting the checkpoint when the run reaches a terminal state (done /
 *     non-resumable blocked) so done-run files don't leak (Review #4 #6)
 */
function persistAfterTransition(runId: string, prev: AutopilotState | undefined, next: AutopilotState): void {
  // Terminal cleanup FIRST — once a run is done/non-resumable, delete its file
  // so it can't be resurrected stale on a later restart, and clear the index.
  const orch = next.orchestrationState;
  if (orch === 'done' || (orch === 'blocked' && next.blockedReason === 'user_stopped')) {
    const root = getCheckpointRoot();
    deleteCheckpoint(runId, root);
    clearSessionIndexEntry(root, next.sessionKey);
    return;
  }
  if (shouldCheckpoint(prev, next)) {
    saveCheckpoint(next, runId, getCheckpointRoot());
  }
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
    // PROD-7: retry_due→claimed is a dead end without an actuator — kick a turn.
    if (updated.orchestrationState === 'claimed') kickResumedTurn(runId, updated);
  }

  return stateByRun.get(runId);
}

/** GAP-25: Evict least-recently-active runs when Map exceeds MAX_RUN_STATES */
function evictOldestRuns(): void {
  while (stateByRun.size > MAX_RUN_STATES) {
    // Find the run with the earliest lastActivityAt (LRU eviction).
    // Falls back to startedAt when lastActivityAt is unset (pre-orchestrator runs).
    let oldestRunId: string | null = null;
    let oldestAt = Infinity;
    for (const [runId, state] of stateByRun) {
      const at = state.lastActivityAt ?? state.startedAt ?? Infinity;
      if (at < oldestAt) {
        oldestAt = at;
        oldestRunId = runId;
      }
    }
    if (oldestRunId == null) break;
    const oldestState = stateByRun.get(oldestRunId);
    // S8: release audit refCount for an evicted still-running run before delete.
    if (oldestState?.status === 'running') setAuditMode('active');
    // Review #4 #6b: also delete the checkpoint so evicted runs don't leak files.
    if (oldestState) deleteCheckpoint(oldestRunId, getCheckpointRoot());
    stateByRun.delete(oldestRunId);
    if (oldestState) {
      sessionKeyToRunId.delete(oldestState.sessionKey);
      canaryFired.delete(oldestState.sessionKey);
      noUsageWarned.delete(oldestState.sessionKey);
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
  const prev = stateByRun.get(runId);
  stateByRun.set(runId, state);
  if (stateByRun.size > MAX_RUN_STATES) evictOldestRuns();
  // Crash-recovery: persist at stable points (orchState/blockedReason/evidence/enabled
  // transitions). Fail-silent + per-runId locked inside saveCheckpoint.
  persistAfterTransition(runId, prev, state);
}

/** GAP-23: Cleanup all state on shutdown */
function cleanupAll(): void {
  // Release audit monitor refCount ONLY for runs that still hold one. A run
  // acquires it on activate and releases on pause/complete/stop, so only
  // status==='running' runs still hold an unreleased refCount. Releasing for
  // paused/done/idle runs would over-release — the audit plugin's refCount could
  // go negative depending on its clamp semantics.
  for (const state of stateByRun.values()) {
    if (state.status === 'running') setAuditMode('active');
  }
  stateByRun.clear();
  sessionIdToKey.clear();
  sessionKeyToRunId.clear();
  canaryFired.clear();
  noUsageWarned.clear();
  if (stallInterval) { clearInterval(stallInterval); stallInterval = null; }
}

function findRunBySession(sessionKey: string): [string, AutopilotState] | undefined {
  const runId = sessionKeyToRunId.get(sessionKey);
  if (!runId) return undefined;
  const state = stateByRun.get(runId);
  return state ? [runId, state] : undefined;
}

/**
 * Resolve an autopilot run for a session key, transparently following a
 * subagent key back to its parent run. Subagent keys have the shape
 * `agent:<main>:subagent:<sub>`; the parent prefix is the run owner.
 * Used by before_model_resolve and llm_output so both treat subagent
 * activity as belonging to the parent run.
 */
function findRunBySessionOrParent(sessionKey: string): [string, AutopilotState] | undefined {
  return findRunBySession(sessionKey)
    ?? (isSubagentSession(sessionKey)
      ? findRunBySession(extractParentSessionKey(sessionKey) ?? '')
      : undefined);
}

// ponytail: production passes sessionKey on ctx, test mocks put it on event — one helper handles both
function resolveSessionKey(event: unknown, ctx?: unknown): string | undefined {
  // Session key can arrive on ctx (production host) or event (test mocks + some
  // hook signatures where the host populates the event payload). Both are
  // host-controlled surfaces — the event is NOT user-influenceable. Code-review
  // M1 flagged the dual-source as a foot-gun, but removing the event fallback
  // breaks 8 tests that simulate the production pattern (some hooks only
  // populate sessionKey on event). Leaving as-is until a deeper audit of
  // per-hook sessionKey provenance is done.
  const c = ctx as { sessionKey?: string; sessionId?: string } | undefined;
  const e = event as { sessionKey?: string; sessionId?: string } | undefined;
  const sessionId = c?.sessionId ?? e?.sessionId;
  return c?.sessionKey ?? e?.sessionKey ?? (sessionId != null ? sessionIdToKey.get(sessionId) : undefined);
}

const CROSS_TURN_FALLBACK_TEXT = 'Continue from where you left off.';

function buildCrossTurnReviseFallback(
  runId: string,
  state: AutopilotState,
  instruction: string | undefined,
) {
  const fallbackState = { ...incrementTotal(state), turnAttempts: 0 };
  setState(runId, fallbackState);
  return {
    action: 'revise' as const,
    retry: {
      instruction: instruction || CROSS_TURN_FALLBACK_TEXT,
      idempotencyKey: `autopilot-${runId}-${fallbackState.totalContinuations}`,
      maxAttempts: fallbackState.maxAttemptsPerTurn,
    },
  };
}

/** Generate a unique run ID using crypto.randomUUID (exported for testing). */
export function _generateRunIdForTest(): string {
  return `run-${crypto.randomUUID()}`;
}

function generateRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

export function register(api: OpenClawPluginApi): void {
  // PROD-7 / LOGIC-4: stash the cross-turn injection actuator so the stall
  // interval and gateway resume (both outside per-call closures) can restart a
  // claimed run. Optional-chained: undefined on hosts without the 5.28+ facade.
  enqueueInjectionFn = api.session?.workflow?.enqueueNextTurnInjection as EnqueueInjectionFn | undefined;
  // Read user config from OpenClaw, merge with defaults
  // pluginConfig is Record<string, unknown> — coerce values to expected types
  const uc = api.pluginConfig ?? {};
  const numOrUndefined = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined;
  const modelRouting = parseModelRouting(uc.modelRouting);
  const config: AutopilotConfig = {
    ...DEFAULT_CONFIG,
    ...(numOrUndefined(uc.maxAttemptsPerTurn) != null ? { maxAttemptsPerTurn: numOrUndefined(uc.maxAttemptsPerTurn)! } : {}),
    ...(numOrUndefined(uc.maxTotalContinuations) != null ? { maxTotalContinuations: numOrUndefined(uc.maxTotalContinuations)! } : {}),
    ...(numOrUndefined(uc.toolErrorThreshold) != null ? { toolErrorThreshold: numOrUndefined(uc.toolErrorThreshold)! } : {}),
    ...(Array.isArray(uc.excludedAgents) ? { excludedAgents: uc.excludedAgents as string[] } : {}),
    ...(Array.isArray(uc.highRiskTools) ? { highRiskTools: uc.highRiskTools as string[] } : {}),
    ...(numOrUndefined(uc.tokenBudget) != null ? { tokenBudget: numOrUndefined(uc.tokenBudget) } : {}),
    ...(numOrUndefined(uc.maxConcurrentAutopilot) != null ? { maxConcurrentAutopilot: numOrUndefined(uc.maxConcurrentAutopilot)! } : {}),
    ...(typeof uc.thinkingIntensity === 'string' && ['low', 'medium', 'high'].includes(uc.thinkingIntensity)
      ? { thinkingIntensity: uc.thinkingIntensity as 'low' | 'medium' | 'high' }
      : {}),
    ...(modelRouting ? { modelRouting } : {}),
    ...(typeof uc.trustWorkspace === 'boolean' ? { trustWorkspace: uc.trustWorkspace } : {}),
  };
  log(`[autopilot] config: maxAttemptsPerTurn=${config.maxAttemptsPerTurn} maxTotalContinuations=${config.maxTotalContinuations} toolErrorThreshold=${config.toolErrorThreshold} excludedAgents=${JSON.stringify(config.excludedAgents)} highRiskTools=${JSON.stringify(config.highRiskTools)} tokenBudget=${config.tokenBudget}`);

  // Crash-recovery: restore ALL resumable runs at process init (Review #3 multi-run
  // gap). session_start only fires for the session that reconnects, but a gateway
  // restart may orphan runs owned by OTHER sessions. Scanning the checkpoints dir
  // here restores every run still in an active family (running/claimed/retry_queued/
  // released/unclaimed) whose workspace still exists. Restored runs are marked
  // degraded:true so operators can tell a restored run from a fresh one.
  {
    // E1/P0-2: migrate legacy-location checkpoints (the gateway-cwd read
    // location) into the fixed root, then read from the fixed root. Going
    // forward every checkpoint lands in the fixed root regardless of workspace.
    const migratedCount = migrateLegacyCheckpoints([process.cwd()]);
    const root = getCheckpointRoot();
    const resumable = listResumableCheckpoints(root);
    for (const runId of resumable) {
      const restored = loadCheckpoint(runId, root);
      if (restored) {
        stateByRun.set(runId, restored);
        sessionKeyToRunId.set(restored.sessionKey, runId);
        if (restored.needsCrossTurnResume) {
          // E11: enqueueInjectionFn is set above (before this restore loop), so
          // kick now rather than waiting for the next stall/retry tick. A
          // restored mid-cross-turn run is 'claimed' and cannot start a turn on
          // its own — without this kick it sits dead until the 24h orphan sweep.
          // kickResumedTurn self-guards on orchState==='claimed'. NOTE (E13):
          // this is a cross-turn send path; E13 (P3-29) must account for it when
          // hardening gateway-restart double-spend.
          kickResumedTurn(runId, restored);
        }
      }
    }
    if (migratedCount > 0) {
      log(`[autopilot] checkpoint migration: moved ${migratedCount} run(s) into the fixed root`);
    }
    if (resumable.length > 0) {
      log(`[autopilot] crash-recovery: restored ${stateByRun.size} run(s) from checkpoints`);
    }
  }

  // --- Hooks (use api.on for typed hooks when available, registerHook as fallback) ---
  const registerHook = api.on?.bind(api) ?? api.registerHook?.bind(api);
  if (!registerHook) {
    error('[autopilot] hook registration API unavailable (api.on and api.registerHook both missing) — plugin disabled');
    return;
  }

  registerHook('before_agent_finalize', async (event: PluginHookBeforeAgentFinalizeEvent) => {
    const sessionKey = resolveSessionKey(event);
    if (sessionKey) canaryFired.add(sessionKey);
    if (!sessionKey) return { action: 'continue' };

    const entry = findRunBySession(sessionKey);
    if (!entry) return { action: 'continue' };

    const [runId, rawState] = entry;

    // ADR-020 step 2: clear needsCrossTurnResume via the reducer (was a bare
    // spread). The flag is the host-driver handshake; without clearing it, the
    // host re-sends chat.send on every sessions.changed broadcast (infinite
    // loop). The reducer is the sole writer of needsCrossTurnResume.
    const state = rawState.needsCrossTurnResume
      ? orchestratorReducer(rawState, { type: 'cross_turn_resume_consumed', runId, now: Date.now() })
      : rawState;
    if (rawState.needsCrossTurnResume) setState(runId, state);

    const decision = decideContinuation(state, {
      lastAssistantMessage: event.lastAssistantMessage,
      stopHookActive: event.stopHookActive,
    });

    log(`[autopilot] before_agent_finalize: session=${sessionKey} action=${decision.action} turn=${state.turnAttempts}/${state.maxAttemptsPerTurn} total=${state.totalContinuations}/${state.maxTotalContinuations}`);

    switch (decision.action) {
      case 'finalize': {
        // S3 (audit 2026-06-30): decideContinuation returns 'finalize' when the
        // run is disabled/non-running, or when stopHookActive is set (user hit
        // stop). Previously this fell through to default and was silently
        // rewritten to 'continue', leaving status='running' so stall/agent_end
        // could revive a run the user had asked to stop. Match pause/complete:
        // emit {action:'finalize'} so the host stops injecting revisions.
        return { action: 'finalize' };
      }
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
              ttlMs: DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs,
            });
            if (result && typeof result === 'object' && result.enqueued === false) {
              warn(`[autopilot] enqueueNextTurnInjection rejected for session=${sessionKey}, falling back to revise`);
              return buildCrossTurnReviseFallback(runId, state, decision.retryInstruction);
            }
            setState(runId, updated);
            return { action: 'finalize' };
          } catch (err) {
            warn(`[autopilot] enqueueNextTurnInjection failed for session=${sessionKey}: ${err}, falling back to revise`);
            return buildCrossTurnReviseFallback(runId, state, decision.retryInstruction);
          }
        }
        return buildCrossTurnReviseFallback(runId, state, decision.retryInstruction);
      }
      case 'pause': {
        setState(runId, orchestratorReducer(state, { type: 'pause_requested', runId, reason: decision.pauseReason!, now: Date.now() }));
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
          // Fail-open (skipped) to avoid zombie sessions — runValidationCommands
          // never throws and evaluateEvidence is pure, so this only trips on a
          // future bug. But do NOT let that bug pass silently: emit it at error
          // level with the failureReason so a monitor can tell an evaluation
          // failure apart from a normal no-commands skip (both end as 'skipped').
          logWithContext('error', 'evidence gate evaluation error (failing open → skipped)', { sessionKey, runId, error: String(err) });
          evidenceSummary = { status: 'skipped' as const, diffSummary: '', commands: [], completedAt: now, failureReason: 'evaluation error' };
        }
        // Dispatch orchestrator events to advance orchState to 'done'.
        // Close the agent turn (running → released) so evidence events can fire.
        let updated = state;
        if (updated.orchestrationState === 'running') {
          updated = orchestratorReducer(updated, {
            type: 'agent_turn_finished', runId, success: true, now,
          });
        }
        if (updated.orchestrationState === 'released') {
          updated = orchestratorReducer(updated, { type: 'evidence_started', runId, now });
          updated = orchestratorReducer(updated, {
            type: 'evidence_finished',
            runId,
            now,
            evidence: evidenceSummary,
          });
        }
        // Apply evidence result to state. The decision branches on evidence outcome:
        // passed/skipped → mark the run done; failed → retry or block (NOT done).
        // Before this fix (H1), the code checked `updated.status === 'done'`, but the
        // reducer leaves status='running' on evidence FAILURE, so failed evidence fell
        // into complete() — producing a false 'done' + enabled:false, which stranded
        // the run (the stall interval's retry_due guard checks state.enabled).
        // See docs/audits/autopilot-correctness-review-2026-07-04.md HIGH finding.
        // ADR-020 Decision #2 (end state): the single path to `done` is the
        // reducer's evidence_finished branch. If evidence passed/skipped but the
        // run is not `done` (reducer no-oped — orchState !== 'released', i.e. a
        // stop/stall/retry race), do NOT force done via complete(); warn and
        // preserve the pre-race orchState. The race is surfaced, not masked.
        if (evidenceSummary.status !== 'failed' && updated.status !== 'done') {
          warn(`[autopilot] evidence gate: evidence ${evidenceSummary.status} but run not in 'done' (orchState=${updated.orchestrationState ?? 'n-a'}, status=${updated.status}); preserving state, not completing (ADR-020 #2)`);
        }
        setState(runId, { ...updated, evidence: evidenceSummary });
        logWithContext('info', 'evidence gate result', { sessionKey, runId, evidenceStatus: evidenceSummary.status, failureReason: evidenceSummary.failureReason });
        // Release audit monitor when task completes — session is done, no more tool calls needed.
        setAuditMode('active');
        return { action: 'finalize' };
      }
      default:
        return { action: 'continue' };
    }
  });

  registerHook('after_tool_call', (event: PluginHookAfterToolCallEvent, ctx: PluginHookAgentContext) => {
    const sessionKey = resolveSessionKey(event, ctx);
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
    warn(`[autopilot] after_tool_call error: session=${sessionKey} tool=${event.toolName} errCount=${withError.toolErrorCount}/${state.toolErrorThreshold}`);
  });

  registerHook('before_compaction', (_event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => {
    const sessionKey = resolveSessionKey(_event, ctx);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (entry?.[1].enabled) {
      log(`[autopilot] before_compaction: session=${sessionKey} preserving goal`);
      setState(entry[0], preserveGoalBeforeCompaction(entry[1]));
    }
  });

  registerHook('after_compaction', (_event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => {
    const sessionKey = resolveSessionKey(_event, ctx);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (entry?.[1].enabled) {
      log(`[autopilot] after_compaction: session=${sessionKey} restoring goal`);
      setState(entry[0], restoreGoalAfterCompaction(entry[1]));
    }
  });

  registerHook('agent_turn_prepare', (event: PluginAgentTurnPrepareEvent, ctx: PluginHookAgentContext) => {
    const sessionKey = ctx?.sessionKey;
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
    // Persist the orchState transition (claimed → running) immediately.
    if (updated !== state) setState(runId, updated);

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

    // Effort injection: graduated intensity by execution phase (TD-1)
    const intensity = resolveThinkingIntensity(
      updated.totalContinuations,
      updated.evidence?.status,
      config.thinkingIntensity,
    );
    const effortCtx = buildEffortInjection(updated.status, intensity);
    if (effortCtx) parts.push(effortCtx);

    // Completion awareness instruction
    parts.push('[Autopilot] When all tasks are complete, explicitly state "All tasks completed".');

    return { appendContext: parts.join('\n') };
  });

  // Model routing: override model per execution phase. Consumed by Gateway via
  // before_model_resolve -> { modelOverride }. No modelIds => no override (inherit).
  // Read-only: state is read without a lock while other hooks mutate it — a turn
  // straddling an evidence-status transition may pick the wrong tier for one turn.
  // Acceptable for a routing heuristic (no data loss, self-corrects next turn).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHook('before_model_resolve', (_event: PluginHookBeforeModelResolveEvent, ctx: PluginHookAgentContext): any => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;

    // Find the autopilot run: direct, or via parent session for subagents
    // (subagent keys: agent:<main>:subagent:<sub>).
    const entry = findRunBySessionOrParent(sessionKey);
    if (!entry?.[1].enabled || entry[1].status !== 'running') return;

    const [, state] = entry;
    // WORKFLOW.md model_routing wins over plugin config when present.
    const routing = state.workflow?.modelRouting ?? modelRouting;
    if (!routing?.modelIds) return;

    // INT-3 (ADR-017): a subagent's own declared model wins over the parent
    // run's subagentTier. The host resolves the child's `.prose model:` (or
    // agent-definition model) BEFORE firing this hook and surfaces it via
    // ctx.modelId. When a subagent carries an explicit declared model, we
    // return without an override so the host keeps it; the parent
    // subagentTier then only applies to children that declared nothing.
    if (isSubagentSession(sessionKey) && ctx.modelId) {
      log(`[autopilot] before_model_resolve: session=${sessionKey} inherit child model=${ctx.modelId}`);
      return;
    }

    const tier = resolveModelTier(
      state.totalContinuations,
      state.evidence?.status,
      isSubagentSession(sessionKey),
      routing,
    );
    const modelId = resolveModelId(tier, routing);
    if (modelId) {
      log(`[autopilot] before_model_resolve: session=${sessionKey} tier=${tier} model=${modelId}`);
      return { modelOverride: modelId };
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerHook('before_agent_run', (_event: PluginHookBeforeAgentRunEvent, ctx: PluginHookAgentContext): any => {
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

  registerHook('before_tool_call', (event: PluginHookBeforeToolCallEvent, ctx: PluginHookAgentContext) => {
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
    // No event.args / event.cwd (verified live 2026-06-28). NOTE: openclaw 2026.7.1 may
    // also populate optional event.toolKind / toolInputKind / derivedPaths (host
    // discriminators); this hook does not read them. Command lives in params.command;
    // cwd in params.workdir.
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
      // F3: persist the per-call working dir so the audit trail is forensically
      // useful — aligns with dynamic-workflows' audit entry. eventCwd already
      // resolved above (params.workdir / cd / git -C); fall back to the workspace.
      cwd: eventCwd ?? state.workspace?.path,
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
      logWithContext('warn', 'before_tool_call BLOCKED', { sessionKey, runId, toolName, reason: decision.reason });
      return {
        block: true,
        blockReason: (decision as { outcome: 'block'; reason: string; message: string }).message,
      };
    }
  }, { priority: BEFORE_TOOL_CALL_PRIORITY });

  registerHook('llm_output', (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;
    // Count subagent tokens toward the PARENT run's budget. before_model_resolve
    // already resolves subagents via their parent (agent:<main>:subagent:<id>);
    // token accounting must match, or a run's tokenBudget under-counts real spend
    // (the budget is enforced at the parent's before_agent_finalize turn boundary).
    const entry = findRunBySessionOrParent(sessionKey);
    if (!entry?.[1].enabled) return;

    const usage = event.usage;
    if (!usage?.total) {
      // S10: when the host omits usage on a run WITH a configured tokenBudget,
      // the budget silently never enforces (totalTokensUsed stays 0). Warn once
      // per session so operators can diagnose "budget not working" instead of
      // silently burning tokens. Skip when no budget is configured (irrelevant).
      if (entry[1].tokenBudget && !noUsageWarned.has(sessionKey)) {
        noUsageWarned.add(sessionKey);
        warn(`[autopilot] llm_output: host did not report token usage for session=${sessionKey} but a tokenBudget is configured — budget enforcement is a no-op until the host reports usage`);
      }
      return;
    }

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

  registerHook('session_start', (event: PluginHookSessionStartEvent) => {
    if (event.sessionId && event.sessionKey) {
      sessionIdToKey.set(event.sessionId, event.sessionKey);
      log(`[autopilot] session_start: ${event.sessionId} → ${event.sessionKey}`);
    }
    // Crash-recovery resume (Review #4 BLOCKER #2): after a gateway restart the
    // in-memory sessionKeyToRunId Map is empty, so we consult the durable
    // session-index.json to locate the checkpoint for this session. register()
    // already restored ALL resumable runs at process init; this path covers the
    // case where a session reconnects (e.g. resumedFrom) and its run isn't yet
    // in memory (different process, late-arriving session_start).
    const sessionKey = event.sessionKey;
    if (sessionKey && !findRunBySession(sessionKey)) {
      const root = getCheckpointRoot();
      const runId = lookupRunIdBySessionKey(root, sessionKey);
      if (runId) {
        const restored = loadCheckpoint(runId, root);
        if (restored) {
          stateByRun.set(runId, restored);
          sessionKeyToRunId.set(sessionKey, runId);
          log(`[autopilot] session_start: resumed run ${runId} for session=${sessionKey} orchState=${restored.orchestrationState ?? 'n/a'}`);
        }
      }
    }
  });

  registerHook('session_end', (event: PluginHookSessionEndEvent) => {
    const sessionKey = event.sessionKey ?? sessionIdToKey.get(event.sessionId);
    sessionIdToKey.delete(event.sessionId);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (entry) {
      const [runId, state] = entry;
      // S8: release the audit monitor refCount for still-running runs before
      // deleting state, mirroring cleanupAll. A leak here pins monitor mode.
      if (state.status === 'running') setAuditMode('active');
      // Crash-recovery: for non-terminal runs, the in-memory state is the most
      // up-to-date copy — ensure it's checkpointed BEFORE deleting from memory
      // so a crash between session_end and the next activity doesn't lose work.
      // (Terminal runs already had their checkpoint deleted in setState.)
      if (state.orchestrationState !== 'done' && state.orchestrationState !== 'blocked') {
        saveCheckpoint(state, runId, getCheckpointRoot());
      }
      stateByRun.delete(runId);
      sessionKeyToRunId.delete(sessionKey);
      canaryFired.delete(sessionKey);
      noUsageWarned.delete(sessionKey);
    }
    log(`[autopilot] session_end: session=${sessionKey} state cleaned up`);
  });

  registerHook('agent_end', async (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
    const sessionKey = resolveSessionKey(event, ctx);
    if (!sessionKey) return;
    const entry = findRunBySession(sessionKey);
    if (!entry) return;
    if (!entry[1].enabled) return;
    const [runId, state] = entry;

    const didFire = canaryFired.has(sessionKey);
    canaryFired.delete(sessionKey);

    if (!didFire) {
      const updated = orchestratorReducer(state, { type: 'degradation_marked', runId, now: Date.now() });
      // M-4: When at max continuations, pause directly instead of requesting cross-turn
      // (cross-turn would just hit max_total_reached again — wasted IPC round-trip)
      if (state.status === 'running' && state.totalContinuations >= state.maxTotalContinuations) {
        setState(runId, orchestratorReducer(updated, { type: 'pause_requested', runId, reason: 'max_total_reached', now: Date.now() }));
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
              ttlMs: DEFAULT_WORKFLOW_CONFIG.stallTimeoutMs,
            });
            if (injectResult && typeof injectResult === 'object' && injectResult.enqueued === false) {
              warn(`[autopilot] agent_end: degraded fallback enqueue rejected for session=${sessionKey}`);
            } else {
              // H-1 / ADR-020 step 1: degraded cross-turn now dispatches through the
              // reducer (was a bare spread). The reducer is the sole writer of these
              // coupled aux fields; it also stamps lastActivityAt (the original
              // spread did not — a deliberate correction, this is real activity).
              const current = stateByRun.get(runId);
              if (!current) {
                // Run vanished during the await — re-create from the pre-await
                // snapshot so the host's queued cross-turn is accounted for.
                setState(runId, continued);
                warn(`[autopilot] agent_end: degraded fallback cross-turn for session=${sessionKey}`);
                return;
              }
              if (current.status !== 'running') {
                // Race: the run transitioned off the active-running family during
                // the await (concurrent stop/pause/stall_timeout). The host already
                // has the queued cross-turn injection; do NOT dispatch
                // cross_turn_degraded — the reducer would no-op (status !== running)
                // and we'd emit a false success warn, leaving an uncounted turn that
                // ignores the user's stop. The stale injection fires once; the
                // before_agent_finalize handler returns 'finalize' for a non-running
                // run, so it does not actually continue. (code-review finding #1.)
                warn(`[autopilot] agent_end: degraded cross-turn enqueued for session=${sessionKey} but run raced to status=${current.status} (orchState=${current.orchestrationState ?? 'n/a'}); not recording cross-turn, stale injection will finalize without continuing`);
                return;
              }
              setState(runId, orchestratorReducer(current, { type: 'cross_turn_degraded', runId, now: Date.now() }));
              warn(`[autopilot] agent_end: degraded fallback cross-turn for session=${sessionKey}`);
              return;
            }
          } catch (err) {
            warn(`[autopilot] agent_end: degraded fallback injection failed: ${err}`);
          }
        }
      }
      // E8 / P1-9 + ticket §2: the degraded fallback must advance
      // totalContinuations (or degraded mode has no termination), AND must do so
      // with the same re-fetch-then-reducer discipline as the cross_turn_degraded
      // success exit above — the rejected/threw paths crossed an await, so
      // spreading the stale pre-await `updated` would clobber a concurrent
      // stop/pause/stall_timeout. Re-fetch; bail on a race; re-apply
      // degradation_marked so degraded:true holds on the fresh snapshot, then
      // increment. The needsCrossTurnResume spread itself stays (E13 / P3-29).
      const fallbackCurrent = stateByRun.get(runId);
      if (fallbackCurrent && fallbackCurrent.status !== 'running') {
        warn(`[autopilot] agent_end: degraded fallback for session=${sessionKey} but run raced to status=${fallbackCurrent.status} (orchState=${fallbackCurrent.orchestrationState ?? 'n-a'}); not recording cross-turn`);
        return;
      }
      const fallbackBase = orchestratorReducer(fallbackCurrent ?? updated, { type: 'degradation_marked', runId, now: Date.now() });
      setState(runId, { ...incrementTotal(resetTurnAttempts(fallbackBase)), needsCrossTurnResume: true });
      warn(`[autopilot] agent_end: canary check failed for session=${sessionKey} — before_agent_finalize never fired, hook may be disabled`);
      return;
    }

    const isBreaker = !event.success && event.error?.toLowerCase().includes('circuit breaker');
    const afterPause = isBreaker ? orchestratorReducer(state, { type: 'pause_requested', runId, reason: 'loop_breaker_triggered', now: Date.now() }) : state;
    // GAP-24: Clear degraded when canary fired — system recovered from degradation
    const afterDegradedClear = didFire ? orchestratorReducer(afterPause, { type: 'degradation_cleared', runId, now: Date.now() }) : afterPause;
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
      if (entry) return projectState(entry[1], config) as unknown as PluginJsonValue;
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
        if (entry) {
          // S8: release audit refCount for still-running runs before delete.
          if (entry[1].status === 'running') setAuditMode('active');
          stateByRun.delete(entry[0]);
        }
        // PROD-2: clear the reverse-index and canary set too, else session-key
        // teardown (without a session_end) leaves dangling map entries.
        sessionKeyToRunId.delete(ctx.sessionKey);
        canaryFired.delete(ctx.sessionKey);
        noUsageWarned.delete(ctx.sessionKey);
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
      // S1-residual A: per-activate opt-in to execute workspace-sourced validation
      // commands. Undefined → fall back to plugin config; both undefined → false.
      const payloadTrustWorkspace: boolean | undefined =
        typeof ctx.trustWorkspace === 'boolean' ? ctx.trustWorkspace : undefined;

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
        // Enhancement C (ADR-019): stamp the EFFECTIVE per-run trust decision
        // (payload ?? config ?? false) onto state. createInitialState copies
        // config.trustWorkspace (plugin-level), but the payload override must
        // win — without this, a payload-trusted run would keep the plugin-level
        // value and minTurnsBeforeComplete would not raise the threshold.
        // applyPayload runs after createInitialState and before applyWorkflowConfig
        // in both activate branches, so this is the single correct stamp point.
        next.trustWorkspace = payloadTrustWorkspace ?? config.trustWorkspace ?? false;
        return next;
      };

      // GAP-6: Load workflow config from WORKFLOW.md
      const applyWorkflowConfig = (s: AutopilotState): AutopilotState => {
        // S1-residual A: workspace-sourced validation commands (WORKFLOW.md +
        // auto-detected `npm test` / `node …`) are NOT executed unless the operator
        // trusts this workspace. Untrusted → commands empty + warning. This is the
        // root-cause boundary: the binary allowlist cannot stop `npm run <script>` /
        // `node evil.js` when the workspace owns the script.
        const trustWorkspace = payloadTrustWorkspace ?? config.trustWorkspace ?? false;
        try {
          // Use payloadWorkspacePath (validated in outer scope by validateWorkspacePath) rather than
          // re-reading ctx.workspacePath raw — prevents path-traversal via WORKFLOW.md loading.
          const result = loadWorkflowConfig(process.cwd(), payloadWorkspacePath);
          let commands = result.config.validation.commands;
          if (!trustWorkspace) {
            commands = [];
          } else if (commands.length === 0 && payloadWorkspacePath) {
            // R-3: Auto-fill validation commands when WORKFLOW.md has none.
            // Only auto-detect when an explicit workspace path is provided AND trusted
            // (not cwd fallback) to avoid running project tests in unexpected dirs.
            commands = detectValidationCommands(payloadWorkspacePath);
          }
          const warnings = trustWorkspace
            ? result.warnings
            : [...result.warnings, 'untrusted workspace — validation commands + model_routing disabled (enable via trustWorkspace:true)'];
          // L1: an untrusted workspace must not influence model selection either.
          // validation.commands are cleared above (RCE boundary); model_routing
          // from the same WORKFLOW.md is dropped here so an attacker-controlled
          // workspace cannot force a different/cheaper model tier. Plugin-level
          // modelRouting (operator config) still applies regardless.
          const { modelRouting: _ignoredModelRouting, ...configWithoutRouting } = result.config;
          const trustedConfig = trustWorkspace ? result.config : configWithoutRouting;
          return {
            ...s,
            workflow: {
              ...trustedConfig,
              validation: { ...result.config.validation, commands },
              warnings,
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
        // M1: use the run's own stallTimeoutMs if configured, not just the global default.
        const stuckStallMs = state.workflow?.stallTimeoutMs
          ?? defaultStallTimeoutMs(!!config.tokenBudget);
        const stuckRecovery = isRunStuck(state, Date.now(), stuckStallMs);
        if (state.status === 'idle' || state.status === 'done' || stuckRecovery) {
          if (stuckRecovery) {
            warn(`[autopilot] activate: recovering stuck session=${sessionKey} (status=${state.status}, orchState=${state.orchestrationState ?? 'none'}) — discarding stale run ${oldRunId}`);
          }
          // Release audit monitor refcount ONLY if the old run still holds one.
          // Per GAP-23 invariant: only status==='running' runs hold an unreleased
          // refCount (acquire on activate, release on pause/complete/stop). The
          // stuckRecovery branch is the only one where oldRunId may still be
          // 'running'. idle/done runs were already released at complete/stop —
          // releasing again would over-release the shared audit refcount (S8).
          if (stuckRecovery) {
            setAuditMode('active');
          }
          stateByRun.delete(oldRunId);
          sessionKeyToRunId.delete(sessionKey);
          const runId = generateRunId();
          let newState = createInitialState(sessionKey, runId, config);
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
          log(`[autopilot] activate: session=${sessionKey} new run=${runId} (was ${state.status}, goalLen=${goalForEvent?.length ?? 0})`);
        } else {
          warn(`[autopilot] activate rejected: session=${sessionKey} status=${state.status}`);
          respond(false, undefined, { code: 'INVALID_REQUEST', message: `cannot activate from status "${state.status}", must be "idle" or "done"` });
          return;
        }
      } else {
        const runId = generateRunId();
        let state = createInitialState(sessionKey, runId, config);
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
      const resumed = resume(orchestrated);
      setState(runId, resumed);
      // LOGIC-4: a programmatic resume has no follow-up user message to trigger
      // agent_turn_prepare, so kick a cross-turn injection to actually continue.
      kickResumedTurn(runId, resumed);
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
        setState(runId, orchestrated);
        log(`[autopilot] stop: session=${sessionKey} ${state.status}→idle`);
      }
      // Release audit monitor refcount when session stops.
      setAuditMode('active');
      respond(true, { ok: true });
  });

  api.registerGatewayMethod('autopilot.status', async ({ params: ctx, respond }: GatewayCtx) => {
      const sessionKey = ctx.sessionKey as string | undefined;
      const entry = sessionKey ? findRunBySession(sessionKey) : undefined;
      const projection = entry ? projectState(entry[1], config) : undefined;
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
      log(`[autopilot] setGoal: session=${sessionKey} goalLen=${goal.length}`);
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

  // M-7: Clear previous interval before creating a new one (HMR / double-register safety)
  if (stallInterval) { clearInterval(stallInterval); stallInterval = null; }

  stallInterval = setInterval(() => {
    const now = Date.now();
    const orphanRunIds: string[] = [];

    for (const [runId, state] of stateByRun.entries()) {
      // GAP-4: Stall detection for active runs.
      // M1 fix: read stallTimeoutMs PER-RUN from the run's workflow config, not
      // the global default. An operator setting `stall_timeout_ms` in WORKFLOW.md
      // expects it to take effect; the global fallback was silently ignoring it.
      const stallTimeoutMs = state.workflow?.stallTimeoutMs
        ?? defaultStallTimeoutMs(!!config.tokenBudget);
      if (state.enabled && state.status === 'running' && (state.orchestrationState === 'running' || state.orchestrationState === 'claimed')) {
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
        // PROD-7: a claimed run cannot self-start a turn — kick one so a genuinely
        // dead agent restarts instead of sitting in claimed until the 24h sweep.
        if (updated.orchestrationState === 'claimed') kickResumedTurn(runId, updated);
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
        // S8: release audit refCount for orphaned still-running runs before delete.
        if (state.status === 'running') setAuditMode('active');
        stateByRun.delete(runId);
        sessionKeyToRunId.delete(state.sessionKey);
        canaryFired.delete(state.sessionKey);
        noUsageWarned.delete(state.sessionKey);
      }
    }
  }, stallCheckIntervalMs);
  // PROD-6: don't let the stall timer keep the event loop alive if the host
  // exits without calling cleanup — unref so the process can drain naturally.
  stallInterval?.unref?.();
}
