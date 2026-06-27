import type { CommandClass } from './types';
/**
 * Resolve a path to its canonical real path, normalising symlinks.
 * Falls back to path.resolve (which at least normalises `.`, `..`, and
 * redundant separators) when the path does not exist on disk.
 *
 * Exported for unit-testing.
 */
export declare function resolveReal(p: string): string;
export interface PermissionDecisionInput {
    toolName: string;
    toolKind?: string;
    command?: string[];
    cwd?: string;
    workspacePath?: string;
    workspaceRoot?: string;
    workflowAllowsDestructiveGit: boolean;
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
//# sourceMappingURL=permission-policy.d.ts.map