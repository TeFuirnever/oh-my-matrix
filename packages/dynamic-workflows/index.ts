/**
 * @oh-my-matrix/dynamic-workflows — OpenClaw plugin: subagent runtime guard.
 *
 * Registers `before_tool_call` (priority 11) that fail-closed blocks
 * destructive ops for `:subagent:` sessions (OpenProse-spawned workflow
 * branches). Higher priority than autopilot (10) and matrixassistant-audit
 * (9) so it runs first and block short-circuits the lower-priority handlers.
 * Main sessions + autopilot runs keep their own behavior.
 *
 * The permission primitives (decidePermission, classifyCommand, audit) now
 * live in @oh-my-matrix/permission-policy (ADR-013); this plugin imports them.
 */
import type { OpenClawPluginApi } from 'openclaw/dist/plugin-sdk/plugin-runtime';
import { decidePermissionForEvent, classifyCommand, appendAuditEntry, extractCommandSegments } from '@oh-my-matrix/permission-policy';
import { logWithContext } from '@oh-my-matrix/permission-policy';

// ─── Projection contract (read-only, host/UI observable) ─────────────────
export { buildDynamicWorkflowProjection, normalizeOpenProseRun, normalizePermissionAuditEntries } from './src/projection';
export type {
  DynamicWorkflowMode,
  DynamicWorkflowPhase,
  DynamicWorkflowBranchPhase,
  DynamicWorkflowSummaryStatus,
  DynamicWorkflowMetadata,
  NormalizedOpenProseRun,
  OpenProseFilesystemRunSnapshot,
  OpenProseFilesystemBindingSnapshot,
  NormalizedWorkflowBranch,
  NormalizedBlockedCall,
  DynamicWorkflowFinalSynthesis,
  DirectSessionSummary,
  DynamicWorkflowBranchState,
  DynamicWorkflowProjection,
  BuildDynamicWorkflowProjectionInput,
} from './src/projection-types';

export const id = 'dynamic-workflows';
export const name = 'Dynamic Workflows Guard';
export const version = '1.1.0';

/**
 * before_tool_call priority — higher than autopilot (10) and
 * matrixassistant-audit (9). OpenClaw runs higher-priority hooks first
 * (openclaw/src/plugins/hooks.ts:267,275); block short-circuits lower ones.
 * So the subagent guard blocks BEFORE autopilot's run-scoped handler or the
 * audit hook touches the call.
 */
const BEFORE_TOOL_CALL_PRIORITY = 11;

/**
 * Detect whether a sessionKey belongs to a spawned subagent (e.g. an
 * OpenProse-spawned workflow branch) vs the main interactive session.
 * Mirrors openclaw's convention (src/sessions/session-key-utils.ts):
 * subagent keys carry a `:subagent:` segment, e.g. `agent:main:subagent:<id>`.
 * Inlined because openclaw does not export this helper via the plugin SDK.
 */
function isSubagentSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(':subagent:');
}

export function _resetForTest(): void {
  // Stateless plugin today — nothing to reset. Kept for API symmetry with
  // autopilot's test harness in case state is added later.
}

interface GuardConfig {
  enabled?: boolean;
  highRiskTools?: string[];
}

export function register(api: OpenClawPluginApi): void {
  const config = ((api as unknown as { pluginConfig?: Record<string, unknown> }).pluginConfig ?? {}) as GuardConfig;

  if (config.enabled === false) {
    // Loud degradation: this is the ONE safety coupling the extraction can't
    // remove — if THIS plugin is disabled, workflow subagents lose runtime
    // guard. Log loudly so it's visible (a disabled plugin still loads +
    // runs register() in OpenClaw; a host-level disable would not).
    logWithContext('warn', 'dynamic-workflows guard DISABLED by config — workflow subagents will NOT be runtime-guarded against destructive ops', {});
    return;
  }

  const registerHook = (api as unknown as {
    on?: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
    registerHook?: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
  });
  const on = registerHook.on?.bind(api as never) ?? registerHook.registerHook?.bind(api as never);
  if (!on) {
    logWithContext('error', 'hook registration API unavailable (api.on and api.registerHook both missing) — dynamic-workflows guard disabled', {});
    return;
  }

  on('before_tool_call', (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey;
    // Fail-closed: a missing sessionKey means we cannot confirm this is NOT a
    // subagent. Blocking (with a clear reason) beats silently passing a possible
    // subagent's destructive call through unguarded. Main sessions always carry a
    // sessionKey, so normal interactive use is unaffected — this only trips if the
    // host breaks the ctx contract, and then a visible block beats a silent leak.
    if (!sessionKey) return { block: true, blockReason: 'dynamic-workflows guard: missing sessionKey — failing closed' };
    // Only enforce for subagent sessions. Main sessions and autopilot runs
    // keep their own behavior (autopilot's run-scoped handler covers its runs;
    // the main interactive session keeps normal approval-based behavior).
    if (!isSubagentSessionKey(sessionKey)) return;

    // Fail-closed: any error while classifying/deciding a confirmed subagent's
    // call blocks it. A guard that throws must not let the call through — that
    // silent fail-open was the 2026-06-28 placebo bug. Scoped below the subagent
    // check so main sessions (already returned above) are never affected.
    try {
      const toolName = event.toolName as string;
      // Real OpenClaw event shape: {toolName, params:{command?, workdir?}, runId, toolCallId}.
      // No event.args / event.cwd (verified live 2026-06-28). NOTE: openclaw 2026.7.1 may
      // also populate optional event.toolKind / toolInputKind / derivedPaths (host
      // discriminators); this guard does not read them. Command lives in params.command
      // (shell string); cwd in params.workdir.
      const { cwd: eventCwd } = extractCommandSegments(event);
      const cwd = eventCwd ?? process.cwd();

      const isConfiguredHighRisk = Array.isArray(config.highRiskTools) && config.highRiskTools.includes(toolName);
      const decision = isConfiguredHighRisk
        ? { outcome: 'block' as const, reason: `${toolName} is configured as high-risk tool`, message: `Tool "${toolName}" is blocked by operator config (highRiskTools)` }
        : decidePermissionForEvent(event, {
            cwd,
            // No workspace context for ad-hoc subagents → destructive-git containment
            // check is skipped (only runs when workflowAllowsDestructiveGit=true), so
            // destructive git falls straight to block. Fail-closed by design.
            workflowAllowsDestructiveGit: false,
            defaultDeny: true, // subagent: unclassified SHELL commands are blocked
          });

      if (decision.outcome !== 'block') return; // allow (read_only / workspace_write / network)

      logWithContext('info', 'before_tool_call BLOCKED (subagent guard)', { sessionKey, toolName, reason: decision.reason });
      appendAuditEntry(
        {
          at: Date.now(),
          runId: `subagent:${sessionKey}`,
          toolName,
          commandClass: decision.commandClass ?? classifyCommand(toolName),
          outcome: 'block',
          reason: decision.reason,
          cwd,
        },
        cwd,
      );
      return {
        block: true,
        blockReason: (decision as { outcome: 'block'; message: string }).message,
      };
    } catch (err) {
      logWithContext('error', 'before_tool_call subagent guard error — failing closed', { sessionKey, error: String(err) });
      return { block: true, blockReason: 'dynamic-workflows guard: internal error — failing closed' };
    }
  }, { priority: BEFORE_TOOL_CALL_PRIORITY });
}
