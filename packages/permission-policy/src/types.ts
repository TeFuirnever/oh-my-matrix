/**
 * Shared permission types — consumed by dynamic-workflows (guard) AND by
 * @oh-my-matrix/autopilot (run-scoped policy). Pure data; no autopilot coupling.
 *
 * These live here (not in autopilot) because decidePermission + classifyCommand
 * + audit-persister are platform-level safety primitives; autopilot is one
 * consumer, the subagent guard is another. See ADR-012.
 */

/** Command classification — drives decidePermission + the audit trail. */
export type CommandClass =
  | 'read_only'
  | 'workspace_write'
  | 'validation'
  | 'safe_git'
  | 'worktree_create'
  | 'workspace_cleanup'
  | 'destructive_git'
  | 'network'
  | 'credential_access'
  | 'system_write'
  | 'unknown';

/** Permission audit trail entry (persisted to JSONL by appendAuditEntry). */
export interface PermissionAuditEntry {
  at: number;
  runId: string;
  toolName: string;
  commandClass: CommandClass;
  outcome: 'allow' | 'require_approval' | 'block';
  reason: string;
  cwd?: string;
  commandSummary?: string;
}
