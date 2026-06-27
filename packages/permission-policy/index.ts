/**
 * @openclaw/permission-policy — shared permission policy primitives.
 *
 * Pure library (NOT a plugin — no openclaw.plugin.json, no hooks, no register()).
 * Consumed by:
 *   - @openclaw/autopilot (run-scoped permission policy + audit)
 *   - @openclaw/dynamic-workflows (subagent guard)
 * Single source of truth for the destructive-op classification + audit trail.
 * See ADR-013.
 */

// ─── Permission policy ──────────────────────────────────────────────────
export { decidePermission, classifyCommand } from './src/permission-policy';
export type { PermissionDecisionInput, PermissionDecision } from './src/permission-policy';

// ─── Audit persistence ──────────────────────────────────────────────────
export { appendAuditEntry, loadRecentAuditEntries, getAuditFilePath } from './src/audit-persister';

// ─── Shared types ───────────────────────────────────────────────────────
export type { CommandClass, PermissionAuditEntry } from './src/types';
