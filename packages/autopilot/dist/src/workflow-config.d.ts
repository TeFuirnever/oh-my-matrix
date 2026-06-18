import type { WorkflowConfig } from './types';
export declare const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig;
interface LoadResult {
    config: WorkflowConfig;
    warnings: string[];
}
/**
 * Load workflow config from WORKFLOW.md in the given repo path.
 * Returns default config if no WORKFLOW.md exists or if parsing fails.
 */
export declare function loadWorkflowConfig(baseRepoPath: string, workspacePath?: string): LoadResult;
export {};
//# sourceMappingURL=workflow-config.d.ts.map