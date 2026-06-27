/**
 * @openclaw/dynamic-workflows — OpenClaw plugin: subagent runtime guard.
 *
 * Registers `before_tool_call` (priority 11) that fail-closed blocks
 * destructive ops for `:subagent:` sessions (OpenProse-spawned workflow
 * branches). Higher priority than autopilot (10) and matrixassistant-audit
 * (9) so it runs first and block short-circuits the lower-priority handlers.
 * Main sessions + autopilot runs keep their own behavior.
 *
 * The permission primitives (decidePermission, classifyCommand, audit) now
 * live in @openclaw/permission-policy (ADR-013); this plugin imports them.
 */
import type { OpenClawPluginApi } from 'openclaw/dist/plugin-sdk/plugin-runtime';
import { decidePermission, classifyCommand, appendAuditEntry } from '@openclaw/permission-policy';
import { logWithContext } from './src/logger';

export const id = 'dynamic-workflows';
export const name = 'Dynamic Workflows Guard';
export const version = '0.1.0';

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
    if (!sessionKey) return;
    // Only enforce for subagent sessions. Main sessions and autopilot runs
    // keep their own behavior (autopilot's run-scoped handler covers its runs;
    // the main interactive session keeps normal approval-based behavior).
    if (!isSubagentSessionKey(sessionKey)) return;

    const toolName = event.toolName as string;
    const toolKind = event.toolKind as string;
    const args = Array.isArray(event.args) ? event.args : [];
    const cwd = (event.cwd as string | undefined) ?? process.cwd();

    const isConfiguredHighRisk = Array.isArray(config.highRiskTools) && config.highRiskTools.includes(toolName);
    const decision = isConfiguredHighRisk
      ? { outcome: 'block' as const, reason: `${toolName} is configured as high-risk tool`, message: `Tool "${toolName}" is blocked by operator config (highRiskTools)` }
      : decidePermission({
          toolName,
          toolKind,
          command: args,
          cwd,
          // No workspace context for ad-hoc subagents → destructive-git
          // containment check is skipped (permission-policy only checks
          // workspace when workflowAllowsDestructiveGit=true), so destructive
          // git falls straight to block. Fail-closed by design.
          workflowAllowsDestructiveGit: false,
        });

    if (decision.outcome !== 'block') return; // allow (read_only / workspace_write / network)

    logWithContext('info', 'before_tool_call BLOCKED (subagent guard)', { sessionKey, toolName, reason: decision.reason });
    appendAuditEntry(
      {
        at: Date.now(),
        runId: `subagent:${sessionKey}`,
        toolName,
        commandClass: classifyCommand(toolName, args, toolKind),
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
  }, { priority: BEFORE_TOOL_CALL_PRIORITY });
}
