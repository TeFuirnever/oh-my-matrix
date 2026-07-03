import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionAuditEntry } from '@oh-my-matrix/permission-policy';
import {
  buildDynamicWorkflowProjection,
  normalizeOpenProseRun,
  normalizePermissionAuditEntries,
} from '../src/projection';
import type {
  DirectSessionSummary,
  DynamicWorkflowFinalSynthesis,
  DynamicWorkflowMetadata,
  NormalizedOpenProseRun,
} from '../src/projection-types';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'projection');

function readJson<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, fileName), 'utf8')) as T;
}

function readJsonl<T>(fileName: string): T[] {
  return readFileSync(join(FIXTURE_DIR, fileName), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

describe('dynamic workflow projection builder', () => {
  it('projects a completed OpenProse run with final synthesis as verified', () => {
    const metadata = readJson<DynamicWorkflowMetadata>('workflow-metadata-basic.json');
    const openProseRun = readJson<NormalizedOpenProseRun>('openprose-run-basic.json');
    const finalSynthesis = readJson<DynamicWorkflowFinalSynthesis>('final-synthesis-present.json');

    const projection = buildDynamicWorkflowProjection({
      metadata,
      openProseRun,
      finalSynthesis,
      now: 1710000300000,
    });

    expect(projection).toMatchObject({
      workflowId: 'dw-fixture-basic',
      mode: 'openprose',
      phase: 'completed',
      selectionReason: metadata.selectionReason,
      prosePath: metadata.prosePath,
      agentCount: 2,
      elapsedMs: 300000,
      summaryStatus: 'verified',
    });
    expect(projection.branchStates.map((branch) => branch.phase)).toEqual(['completed', 'completed']);
    expect(projection.artifacts).toEqual([
      '.openclaw/workflows/dw-fixture-basic.prose',
      '.openclaw/workflows/dw-fixture-basic/run-state.json',
      '.openclaw/workflows/dw-fixture-basic/research.md',
      '.openclaw/workflows/dw-fixture-basic/review.md',
      '.openclaw/workflows/dw-fixture-basic/final-synthesis.md',
    ]);
  });

  it('normalizes a filesystem OpenProse run snapshot into the stable projection boundary', () => {
    const normalized = normalizeOpenProseRun(readJson<unknown>('openprose-filesystem-run-basic.raw.json'));

    expect(normalized).toEqual({
      workflowId: 'dw-fixture-basic',
      phase: 'completed',
      branches: [
        {
          id: 'research',
          name: 'Research',
          phase: 'completed',
          required: true,
          summary: 'Collected runtime evidence.',
          artifacts: ['.openclaw/workflows/dw-fixture-basic/research.md'],
        },
        {
          id: 'review',
          name: 'Review',
          phase: 'completed',
          required: true,
          summary: 'Reviewed synthesis risks.',
          artifacts: ['.openclaw/workflows/dw-fixture-basic/review.md'],
        },
      ],
      artifacts: [
        '.prose/runs/20260702-132000-dwfixture/state.md',
        '.openclaw/workflows/dw-fixture-basic/research.md',
        '.openclaw/workflows/dw-fixture-basic/review.md',
      ],
      errors: [],
    });
  });

  it('rejects unsupported OpenProse raw snapshots instead of guessing their shape', () => {
    expect(() => normalizeOpenProseRun({ workflowId: 'dw-fixture-basic', branches: [] })).toThrow(
      'Unsupported OpenProse run snapshot kind',
    );
  });

  it('keeps completed branches uncertain when final synthesis is missing', () => {
    const projection = buildDynamicWorkflowProjection({
      metadata: readJson<DynamicWorkflowMetadata>('workflow-metadata-basic.json'),
      openProseRun: readJson<NormalizedOpenProseRun>('openprose-run-basic.json'),
      finalSynthesis: { status: 'missing', artifacts: [], evidenceRefs: [] },
      now: 1710000300000,
    });

    expect(projection.phase).toBe('completed');
    expect(projection.summaryStatus).toBe('uncertain');
  });

  it('normalizes workflow-level guard audit blocks without guessing a branch id', () => {
    const blockedCalls = normalizePermissionAuditEntries(
      readJsonl<PermissionAuditEntry>('permission-audit-blocked.jsonl'),
    );

    expect(blockedCalls).toEqual([
      {
        at: 1710000123456,
        toolName: 'exec',
        reason: 'Subagent guard blocked destructive git command.',
        cwd: '<test-workspace>',
        commandClass: 'destructive_git',
      },
    ]);

    const projection = buildDynamicWorkflowProjection({
      metadata: readJson<DynamicWorkflowMetadata>('workflow-metadata-basic.json'),
      openProseRun: readJson<NormalizedOpenProseRun>('openprose-run-basic.json'),
      blockedCalls,
      finalSynthesis: { status: 'missing', artifacts: [], evidenceRefs: [] },
      now: 1710000300000,
    });

    expect(projection.blockedCalls[0]?.branchId).toBeUndefined();
    expect(projection.branchStates.map((branch) => branch.phase)).toEqual(['completed', 'completed']);
    expect(projection.summaryStatus).toBe('uncertain');
  });

  it('projects direct-session summaries without OpenProse state', () => {
    const projection = buildDynamicWorkflowProjection({
      metadata: readJson<DynamicWorkflowMetadata>('workflow-metadata-direct.json'),
      directSessions: readJson<DirectSessionSummary[]>('direct-sessions-basic.json'),
      now: 1710001120000,
    });

    expect(projection).toMatchObject({
      workflowId: 'dw-fixture-direct',
      mode: 'direct-sessions',
      phase: 'completed',
      agentCount: 2,
      elapsedMs: 120000,
      summaryStatus: 'uncertain',
    });
    expect(projection.branchStates.map((branch) => branch.id)).toEqual(['session-a', 'session-b']);
  });

  it('keeps direct-session fallback without summaries reduced and uncertain', () => {
    const projection = buildDynamicWorkflowProjection({
      metadata: readJson<DynamicWorkflowMetadata>('workflow-metadata-direct.json'),
      now: 1710001120000,
    });

    expect(projection.phase).toBe('completed');
    expect(projection.agentCount).toBe(0);
    expect(projection.branchStates).toEqual([]);
    expect(projection.summaryStatus).toBe('uncertain');
  });

  it('projects plan-only workflows as planned without branch state', () => {
    const projection = buildDynamicWorkflowProjection({
      metadata: readJson<DynamicWorkflowMetadata>('workflow-metadata-plan-only.json'),
      now: 1710002000000,
    });

    expect(projection).toMatchObject({
      workflowId: 'dw-fixture-plan',
      mode: 'plan-only',
      phase: 'planned',
      agentCount: 0,
      elapsedMs: 0,
      summaryStatus: 'uncertain',
    });
    expect(projection.branchStates).toEqual([]);
    expect(projection.artifacts).toEqual(['.openclaw/workflows/dw-fixture-plan.prose']);
  });

  it('reports partial when one required branch completed and another failed', () => {
    const projection = buildDynamicWorkflowProjection({
      metadata: readJson<DynamicWorkflowMetadata>('workflow-metadata-basic.json'),
      openProseRun: readJson<NormalizedOpenProseRun>('openprose-run-blocked.json'),
      finalSynthesis: { status: 'missing', artifacts: [], evidenceRefs: [] },
      now: 1710000180000,
    });

    expect(projection.phase).toBe('completed');
    expect(projection.branchStates.map((branch) => branch.phase)).toEqual(['completed', 'failed']);
    expect(projection.summaryStatus).toBe('partial');
  });

  it('rejects invalid metadata without a workflow id', () => {
    expect(() =>
      buildDynamicWorkflowProjection({
        metadata: { mode: 'openprose', createdAt: 1710000000000 } as DynamicWorkflowMetadata,
      }),
    ).toThrow('metadata.workflowId is required');
  });

  it('does not mutate projection inputs', () => {
    const input = {
      metadata: readJson<DynamicWorkflowMetadata>('workflow-metadata-basic.json'),
      openProseRun: readJson<NormalizedOpenProseRun>('openprose-run-basic.json'),
      finalSynthesis: readJson<DynamicWorkflowFinalSynthesis>('final-synthesis-present.json'),
      now: 1710000300000,
    };
    const before = JSON.stringify(input);

    const projection = buildDynamicWorkflowProjection(deepFreeze(input));

    projection.branchStates[0]!.phase = 'failed';
    projection.artifacts.push('mutated-by-caller');

    expect(JSON.stringify(input)).toBe(before);
    expect(input.openProseRun.branches[0]!.phase).toBe('completed');
    expect(input.openProseRun.artifacts).not.toContain('mutated-by-caller');
  });
});
