/**
 * @oh-my-matrix/permission-policy — shared permission policy primitives.
 *
 * Pure library (NOT a plugin — no openclaw.plugin.json, no hooks, no register()).
 * Consumed by:
 *   - @oh-my-matrix/autopilot (run-scoped permission policy + audit)
 *   - @oh-my-matrix/dynamic-workflows (subagent guard)
 * Single source of truth for the destructive-op classification + audit trail.
 * See ADR-013.
 */

// ─── Permission policy ──────────────────────────────────────────────────
export {
  decidePermission,
  classifyCommand,
  decidePermissionForEvent,
  extractCommandSegments,
  tokenizeShell,
} from './src/permission-policy';
export type {
  PermissionDecisionInput,
  PermissionDecision,
  EventPermissionInput,
  ToolEventLike,
} from './src/permission-policy';

// ─── Audit persistence ──────────────────────────────────────────────────
export { appendAuditEntry, loadRecentAuditEntries, getAuditFilePath, getAuditWriteFailureCount } from './src/audit-persister';

// ─── Shared types ───────────────────────────────────────────────────────
export type { CommandClass, PermissionAuditEntry } from './src/types';
