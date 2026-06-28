import type { CommandClass } from './types';
/**
 * Resolve a path to its canonical real path, normalising symlinks.
 * Falls back to path.resolve (which at least normalises `.`, `..`, and
 * redundant separators) when the path does not exist on disk.
 *
 * Exported for unit-testing.
 */
export declare function resolveReal(p: string): string;
/**
 * Minimal view of the OpenClaw `before_tool_call` event — only the fields the
 * guard reads. The real event (`PluginHookBeforeToolCallEvent`) has exactly
 * `["toolName","params","runId","toolCallId"]` (verified live 2026-06-28): there
 * is NO `args` and NO `cwd`. Shell commands live in `params.command` (string),
 * cwd in `params.workdir`.
 */
export interface ToolEventLike {
    toolName: string;
    params?: Record<string, unknown> | undefined;
}
/**
 * Split a shell command string into argv, respecting single/double quotes.
 * Mirrors autopilot's parseCommandArgs. Does NOT expand $vars/globs —
 * classification only needs the binary + flags.
 */
export declare function tokenizeShell(command: string): string[];
/**
 * Extract argv segments + cwd from a REAL `before_tool_call` event.
 *
 * Real subagent shell calls look like `cd /ws && git status 2>&1` — one
 * `params.command` string chained with shell operators. We split on those
 * operators so each sub-command is classified independently (otherwise the
 * leading `cd` masks a trailing `git reset --hard` → fail-open). cwd comes from
 * `params.workdir` (host-authoritative); falls back to the first `cd <dir>`.
 *
 * Non-shell tools (read/process/update_plan/sessions_*) have no `params.command`
 * → empty segments; the caller classifies by toolName alone.
 */
export declare function extractCommandSegments(event: ToolEventLike): {
    segments: string[][];
    cwd: string | undefined;
    hasShellFeature: boolean;
};
export interface PermissionDecisionInput {
    toolName: string;
    toolKind?: string;
    command?: string[];
    cwd?: string;
    workspacePath?: string;
    workspaceRoot?: string;
    workflowAllowsDestructiveGit: boolean;
    /** When true (untrusted/subagent sessions), unclassified commands are BLOCKED
     *  instead of allowed. Default false — trusted autopilot runs keep allow-by-default. */
    defaultDeny?: boolean;
}
export type PermissionDecision = {
    outcome: 'allow';
    reason: string;
    audit: true;
} | {
    outcome: 'block';
    reason: string;
    message: string;
};
/**
 * Classify a command/tool call into a CommandClass category.
 */
export declare function classifyCommand(tool: string, args?: string[], toolKind?: string): CommandClass;
/**
 * Decide permission for a tool call based on classification.
 */
export declare function decidePermission(input: PermissionDecisionInput): PermissionDecision;
/**
 * Decide permission for a REAL OpenClaw `before_tool_call` event.
 *
 * Splits `params.command` on shell operators (&&/||/;/|) and classifies each
 * segment independently — a destructive segment anywhere in the chain blocks the
 * whole call. Non-shell tools (no params.command) classify by toolName alone.
 *
 * This is the entry point guards MUST call; it replaces the old
 * `decidePermission({ command: event.args })` path that read a non-existent
 * `event.args` field (the fail-open root cause, verified live 2026-06-28).
 */
export interface EventPermissionInput {
    cwd?: string;
    workspacePath?: string;
    workspaceRoot?: string;
    workflowAllowsDestructiveGit: boolean;
    defaultDeny?: boolean;
}
export declare function decidePermissionForEvent(event: ToolEventLike, opts: EventPermissionInput): PermissionDecision;
/**
 * Most dangerous CommandClass across shell segments — for audit accuracy.
 * decidePermissionForEvent already blocks on any dangerous segment; this reports
 * WHICH class for the audit trail. Picking segments[0] would mis-record
 * `cd X && git reset --hard` as read_only (the cd segment) instead of destructive_git.
 */
export declare function mostDangerousClass(toolName: string, segments: string[][]): CommandClass;
//# sourceMappingURL=permission-policy.d.ts.map