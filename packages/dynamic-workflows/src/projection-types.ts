export type DynamicWorkflowMode = 'openprose' | 'direct-sessions' | 'plan-only';

export type DynamicWorkflowPhase = 'planned' | 'running' | 'blocked' | 'completed' | 'failed';

export type DynamicWorkflowBranchPhase = 'pending' | 'running' | 'blocked' | 'completed' | 'failed';

export type DynamicWorkflowSummaryStatus = 'verified' | 'partial' | 'blocked' | 'uncertain';

export interface DynamicWorkflowMetadata {
  workflowId: string;
  mode: DynamicWorkflowMode;
  selectionReason?: string;
  prosePath?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface NormalizedOpenProseRun {
  workflowId: string;
  phase: 'planned' | 'running' | 'completed' | 'failed';
  startedAt?: number;
  updatedAt?: number;
  branches: NormalizedWorkflowBranch[];
  artifacts: string[];
  errors: Array<{
    at?: number;
    branchId?: string;
    message: string;
  }>;
}

export interface OpenProseFilesystemRunSnapshot {
  kind: 'openprose-filesystem-run-v1';
  workflowId: string;
  statePath: string;
  stateMarkdown: string;
  bindings: OpenProseFilesystemBindingSnapshot[];
}

export interface OpenProseFilesystemBindingSnapshot {
  name: string;
  path: string;
  markdown: string;
}

export interface NormalizedWorkflowBranch {
  id: string;
  name?: string;
  phase: 'pending' | 'running' | 'completed' | 'failed';
  required?: boolean;
  summary?: string;
  artifacts: string[];
}

export interface NormalizedBlockedCall {
  at: number;
  branchId?: string;
  toolName: string;
  reason: string;
  cwd?: string;
  commandClass?: string;
}

export interface DynamicWorkflowFinalSynthesis {
  status: 'present' | 'missing' | 'blocked';
  artifacts: string[];
  evidenceRefs: string[];
}

export interface DirectSessionSummary {
  id: string;
  name?: string;
  phase: DynamicWorkflowBranchPhase;
  summary?: string;
  artifacts: string[];
}

export interface DynamicWorkflowBranchState {
  id: string;
  name?: string;
  phase: DynamicWorkflowBranchPhase;
  summary?: string;
  artifacts: string[];
}

export interface DynamicWorkflowProjection {
  workflowId: string;
  phase: DynamicWorkflowPhase;
  mode: DynamicWorkflowMode;
  selectionReason?: string;
  prosePath?: string;
  agentCount: number;
  elapsedMs: number;
  branchStates: DynamicWorkflowBranchState[];
  blockedCalls: NormalizedBlockedCall[];
  artifacts: string[];
  summaryStatus: DynamicWorkflowSummaryStatus;
}

export interface BuildDynamicWorkflowProjectionInput {
  metadata: DynamicWorkflowMetadata;
  openProseRun?: NormalizedOpenProseRun;
  directSessions?: DirectSessionSummary[];
  blockedCalls?: NormalizedBlockedCall[];
  finalSynthesis?: DynamicWorkflowFinalSynthesis;
  now?: number;
}
