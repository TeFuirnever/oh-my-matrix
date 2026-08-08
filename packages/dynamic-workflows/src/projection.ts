import type { PermissionAuditEntry } from '@oh-my-matrix/permission-policy';
import type {
  BuildDynamicWorkflowProjectionInput,
  DirectSessionSummary,
  DynamicWorkflowBranchPhase,
  DynamicWorkflowBranchState,
  DynamicWorkflowFinalSynthesis,
  DynamicWorkflowMetadata,
  DynamicWorkflowPhase,
  DynamicWorkflowProjection,
  DynamicWorkflowSummaryStatus,
  NormalizedBlockedCall,
  NormalizedOpenProseRun,
  NormalizedWorkflowBranch,
  OpenProseFilesystemBindingSnapshot,
  OpenProseFilesystemRunSnapshot,
} from './projection-types';

interface BranchWithRequired {
  state: DynamicWorkflowBranchState;
  required?: boolean;
}

export function buildDynamicWorkflowProjection(
  input: BuildDynamicWorkflowProjectionInput,
): DynamicWorkflowProjection {
  const { metadata } = input;
  validateMetadata(metadata);

  const blockedCalls = copyBlockedCalls(input.blockedCalls ?? []);
  const branches = buildBranchStates(input, blockedCalls);
  const branchStates = branches.map(({ state }) => copyBranchState(state));

  return {
    workflowId: metadata.workflowId,
    phase: derivePhase(metadata, input.openProseRun, input.directSessions, branches, input.finalSynthesis),
    mode: metadata.mode,
    selectionReason: metadata.selectionReason,
    prosePath: metadata.prosePath,
    agentCount: branchStates.length,
    elapsedMs: deriveElapsedMs(metadata, input.openProseRun, input.now),
    branchStates,
    blockedCalls,
    artifacts: collectArtifacts(metadata, input.openProseRun, input.directSessions, input.finalSynthesis),
    summaryStatus: deriveSummaryStatus(branches, input.finalSynthesis),
  };
}

export function normalizePermissionAuditEntries(entries: PermissionAuditEntry[]): NormalizedBlockedCall[] {
  return entries
    .filter((entry) => entry.outcome === 'block')
    .map((entry) => {
      const blockedCall: NormalizedBlockedCall = {
        at: entry.at,
        toolName: entry.toolName,
        reason: entry.reason,
      };
      if (entry.cwd) blockedCall.cwd = entry.cwd;
      if (entry.commandClass) blockedCall.commandClass = entry.commandClass;
      return blockedCall;
    });
}

export function normalizeOpenProseRun(raw: unknown): NormalizedOpenProseRun {
  const snapshot = readFilesystemSnapshot(raw);
  const branches = snapshot.bindings
    .map(normalizeFilesystemBinding)
    .filter((branch): branch is NormalizedWorkflowBranch => branch !== undefined);

  return {
    workflowId: snapshot.workflowId,
    phase: deriveOpenProsePhase(snapshot.stateMarkdown, branches),
    branches,
    artifacts: [snapshot.statePath, ...branches.flatMap((branch) => branch.artifacts)],
    errors: branches
      .filter((branch) => branch.phase === 'failed')
      .map((branch) => ({
        branchId: branch.id,
        message: branch.summary || `OpenProse branch ${branch.id} failed`,
      })),
  };
}

function validateMetadata(metadata: DynamicWorkflowMetadata): void {
  if (!metadata.workflowId) {
    throw new Error('Dynamic workflow metadata.workflowId is required');
  }
}

function readFilesystemSnapshot(raw: unknown): OpenProseFilesystemRunSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('OpenProse run snapshot must be an object');
  }

  const candidate = raw as Partial<OpenProseFilesystemRunSnapshot>;
  if (candidate.kind !== 'openprose-filesystem-run-v1') {
    throw new Error('Unsupported OpenProse run snapshot kind');
  }
  if (!candidate.workflowId) {
    throw new Error('OpenProse run snapshot workflowId is required');
  }
  if (!candidate.statePath) {
    throw new Error('OpenProse run snapshot statePath is required');
  }
  if (typeof candidate.stateMarkdown !== 'string') {
    throw new Error('OpenProse run snapshot stateMarkdown is required');
  }
  if (!Array.isArray(candidate.bindings)) {
    throw new Error('OpenProse run snapshot bindings must be an array');
  }

  return {
    kind: candidate.kind,
    workflowId: candidate.workflowId,
    statePath: candidate.statePath,
    stateMarkdown: candidate.stateMarkdown,
    bindings: candidate.bindings,
  };
}

function normalizeFilesystemBinding(
  binding: OpenProseFilesystemBindingSnapshot,
): NormalizedWorkflowBranch | undefined {
  const parsed = parseBindingMarkdown(binding.markdown);
  if (parsed.metadata.kind !== 'session') {
    return undefined;
  }

  return {
    id: parsed.metadata.id || binding.name,
    name: parsed.metadata.name || parsed.metadata.source,
    phase: mapBindingStatus(parsed.metadata.status),
    required: parsed.metadata.required === 'true' ? true : undefined,
    summary: parsed.content || undefined,
    artifacts: parsed.metadata.artifact ? [parsed.metadata.artifact] : [binding.path],
  };
}

function parseBindingMarkdown(markdown: string): {
  metadata: Record<string, string>;
  content: string;
} {
  if (!markdown.startsWith('---\n')) {
    return { metadata: {}, content: markdown.trim() };
  }

  const end = markdown.indexOf('\n---', 4);
  if (end === -1) {
    return { metadata: {}, content: markdown.trim() };
  }

  const frontmatter = markdown.slice(4, end);
  const content = markdown.slice(end + 4).trim();
  const metadata: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) metadata[key] = value;
  }

  return { metadata, content };
}

function mapBindingStatus(status: string | undefined): NormalizedWorkflowBranch['phase'] {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
    case 'executing':
      return 'running';
    case 'failed':
    case 'error':
      return 'failed';
    case 'complete':
    case 'completed':
    default:
      return 'completed';
  }
}

function deriveOpenProsePhase(
  stateMarkdown: string,
  branches: NormalizedWorkflowBranch[],
): NormalizedOpenProseRun['phase'] {
  if (stateMarkdown.includes('<-- EXECUTING') || stateMarkdown.includes('[not yet entered]')) {
    return 'running';
  }
  if (stateMarkdown.includes('(failed)') || branches.some((branch) => branch.phase === 'failed')) {
    return 'failed';
  }
  if (branches.length > 0 && branches.every((branch) => branch.phase === 'completed')) {
    return 'completed';
  }
  return 'planned';
}

function buildBranchStates(
  input: BuildDynamicWorkflowProjectionInput,
  blockedCalls: NormalizedBlockedCall[],
): BranchWithRequired[] {
  if (input.metadata.mode === 'openprose' && input.openProseRun) {
    return input.openProseRun.branches.map((branch) => ({
      state: {
        id: branch.id,
        name: branch.name,
        phase: branchPhaseWithMappedBlock(branch, blockedCalls),
        summary: branch.summary,
        artifacts: [...branch.artifacts],
      },
      required: branch.required,
    }));
  }

  if (input.metadata.mode === 'direct-sessions' && input.directSessions) {
    return input.directSessions.map((session) => ({
      state: directSessionToBranchState(session),
      required: true,
    }));
  }

  return [];
}

function branchPhaseWithMappedBlock(
  branch: NormalizedWorkflowBranch,
  blockedCalls: NormalizedBlockedCall[],
): DynamicWorkflowBranchPhase {
  if (blockedCalls.some((call) => call.branchId === branch.id)) {
    return 'blocked';
  }
  return branch.phase;
}

function directSessionToBranchState(session: DirectSessionSummary): DynamicWorkflowBranchState {
  return {
    id: session.id,
    name: session.name,
    phase: session.phase,
    summary: session.summary,
    artifacts: [...session.artifacts],
  };
}

function derivePhase(
  metadata: DynamicWorkflowMetadata,
  openProseRun: NormalizedOpenProseRun | undefined,
  directSessions: DirectSessionSummary[] | undefined,
  branches: BranchWithRequired[],
  finalSynthesis: DynamicWorkflowFinalSynthesis | undefined,
): DynamicWorkflowPhase {
  if (metadata.mode === 'plan-only') {
    return 'planned';
  }

  if (finalSynthesis?.status === 'blocked' || allRequiredBranchesBlocked(branches)) {
    return 'blocked';
  }

  if (metadata.mode === 'openprose' && openProseRun) {
    return openProseRun.phase;
  }

  if (metadata.mode === 'direct-sessions') {
    if (directSessions && directSessions.length > 0) {
      return derivePhaseFromBranchPhases(directSessions.map((session) => session.phase));
    }
    return derivePhaseFromMetadata(metadata);
  }

  return derivePhaseFromMetadata(metadata);
}

function derivePhaseFromBranchPhases(phases: DynamicWorkflowBranchPhase[]): DynamicWorkflowPhase {
  if (phases.some((phase) => phase === 'blocked')) return 'blocked';
  if (phases.some((phase) => phase === 'failed')) return 'failed';
  if (phases.some((phase) => phase === 'pending' || phase === 'running')) return 'running';
  return 'completed';
}

function derivePhaseFromMetadata(metadata: DynamicWorkflowMetadata): DynamicWorkflowPhase {
  if (metadata.completedAt !== undefined) return 'completed';
  if (metadata.startedAt !== undefined) return 'running';
  return 'planned';
}

function deriveElapsedMs(
  metadata: DynamicWorkflowMetadata,
  openProseRun: NormalizedOpenProseRun | undefined,
  now: number | undefined,
): number {
  const startedAt = metadata.startedAt ?? openProseRun?.startedAt;
  if (startedAt === undefined) return 0;

  const endedAt = now ?? metadata.completedAt ?? openProseRun?.updatedAt ?? Date.now();
  return Math.max(0, endedAt - startedAt);
}

function collectArtifacts(
  metadata: DynamicWorkflowMetadata,
  openProseRun: NormalizedOpenProseRun | undefined,
  directSessions: DirectSessionSummary[] | undefined,
  finalSynthesis: DynamicWorkflowFinalSynthesis | undefined,
): string[] {
  const artifacts: string[] = [];
  if (metadata.prosePath) artifacts.push(metadata.prosePath);
  if (openProseRun) {
    artifacts.push(...openProseRun.artifacts);
    for (const branch of openProseRun.branches) {
      artifacts.push(...branch.artifacts);
    }
  }
  if (directSessions) {
    for (const session of directSessions) {
      artifacts.push(...session.artifacts);
    }
  }
  if (finalSynthesis) {
    artifacts.push(...finalSynthesis.artifacts);
  }
  return [...new Set(artifacts)];
}

function deriveSummaryStatus(
  branches: BranchWithRequired[],
  finalSynthesis: DynamicWorkflowFinalSynthesis | undefined,
): DynamicWorkflowSummaryStatus {
  if (finalSynthesis?.status === 'blocked' || allRequiredBranchesBlocked(branches)) {
    return 'blocked';
  }

  const requiredBranches = selectRequiredBranches(branches);
  const hasCompleted = requiredBranches.some(({ state }) => state.phase === 'completed');
  const hasFailedOrBlocked = requiredBranches.some(
    ({ state }) => state.phase === 'failed' || state.phase === 'blocked',
  );

  if (hasCompleted && hasFailedOrBlocked) {
    return 'partial';
  }

  if (
    requiredBranches.length > 0 &&
    requiredBranches.every(({ state }) => state.phase === 'completed') &&
    finalSynthesis?.status === 'present'
  ) {
    return 'verified';
  }

  return 'uncertain';
}

function selectRequiredBranches(branches: BranchWithRequired[]): BranchWithRequired[] {
  const explicitlyRequired = branches.filter((branch) => branch.required === true);
  return explicitlyRequired.length > 0 ? explicitlyRequired : branches;
}

function allRequiredBranchesBlocked(branches: BranchWithRequired[]): boolean {
  const requiredBranches = selectRequiredBranches(branches);
  return (
    requiredBranches.length > 0 &&
    requiredBranches.every(({ state }) => state.phase === 'blocked')
  );
}

function copyBranchState(branch: DynamicWorkflowBranchState): DynamicWorkflowBranchState {
  return {
    id: branch.id,
    name: branch.name,
    phase: branch.phase,
    summary: branch.summary,
    artifacts: [...branch.artifacts],
  };
}

function copyBlockedCalls(blockedCalls: NormalizedBlockedCall[]): NormalizedBlockedCall[] {
  return blockedCalls.map((call) => ({ ...call }));
}
