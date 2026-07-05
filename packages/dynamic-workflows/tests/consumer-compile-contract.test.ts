/**
 * Consumer compile contract test (ADR-014 gate).
 *
 * ADR-014 § Non-Decisions states: "Package exports should wait until
 * fixture-backed builder tests and a consumer compile check exist."
 *
 * The fixture-backed tests exist (tests/projection.test.ts). This file is the
 * consumer compile check: it imports the projection API via the package name
 * '@oh-my-matrix/dynamic-workflows' (as a real consumer would), not via a
 * relative path. If the barrel export is broken, removed, or renamed, this
 * test fails to compile — catching the drift before it reaches npm.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDynamicWorkflowProjection,
  normalizeOpenProseRun,
  normalizePermissionAuditEntries,
} from '@oh-my-matrix/dynamic-workflows';

describe('consumer compile contract (ADR-014 export gate)', () => {
  it('buildDynamicWorkflowProjection is callable via package import', () => {
    expect(typeof buildDynamicWorkflowProjection).toBe('function');
  });

  it('normalizeOpenProseRun is callable via package import', () => {
    expect(typeof normalizeOpenProseRun).toBe('function');
  });

  it('normalizePermissionAuditEntries is callable via package import', () => {
    expect(typeof normalizePermissionAuditEntries).toBe('function');
  });

  it('buildDynamicWorkflowProjection accepts the documented input shape', () => {
    const result = buildDynamicWorkflowProjection({
      metadata: {
        workflowId: 'wf-test',
        createdAt: '2026-07-06T00:00:00Z',
        pattern: 'fan-out-reduce',
        mode: 'plan-only',
      },
    });
    expect(result).toBeDefined();
    expect(result.summaryStatus).toBeDefined();
  });
});
