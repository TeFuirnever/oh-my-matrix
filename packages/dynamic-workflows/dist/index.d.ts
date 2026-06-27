/**
 * @openclaw/dynamic-workflows — OpenClaw plugin + shared permission library.
 *
 * Two roles:
 * 1. PLUGIN ENTRY: `register(api)` registers a `before_tool_call` hook
 *    (priority 11) that fail-closed blocks destructive ops for `:subagent:`
 *    sessions (OpenProse-spawned workflow branches). Higher priority than
 *    autopilot (10) and matrixassistant-audit (9) so it runs first and block
 *    short-circuits the lower-priority handlers. Main sessions + autopilot
 *    runs keep their own behavior (the guard only fires on `:subagent:`).
 * 2. LIBRARY: re-exports the shared permission primitives (decidePermission,
 *    classifyCommand, audit) consumed by @openclaw/autopilot's run-scoped
 *    policy. Single source of truth for safety policy. See ADR-012.
 */
import type { OpenClawPluginApi } from 'openclaw/dist/plugin-sdk/plugin-runtime';
export { decidePermission, classifyCommand } from './src/permission-policy';
export type { PermissionDecisionInput, PermissionDecision } from './src/permission-policy';
export { appendAuditEntry, loadRecentAuditEntries, getAuditFilePath } from './src/audit-persister';
export type { CommandClass, PermissionAuditEntry } from './src/types';
export declare const id = "dynamic-workflows";
export declare const name = "Dynamic Workflows Guard";
export declare const version = "0.1.0";
export declare function _resetForTest(): void;
export declare function register(api: OpenClawPluginApi): void;
//# sourceMappingURL=index.d.ts.map