/**
 * T13 E2E: WORKFLOW.md → loadWorkflowConfig → state.workflow round-trip,
 *          and destructiveGit.allow → permission decision flow-through.
 *
 * Writes a REAL WORKFLOW.md (YAML front-matter `autopilot:` block) in an
 * os.tmpdir() workspace, then drives the PUBLIC register() API:
 *
 *   autopilot.activate { workspacePath }   → loadWorkflowConfig reads the file,
 *                                            parses + merges, stores state.workflow
 *   autopilot.status                       → asserts state.workflow matches parsed
 *                                            config (source, destructiveGit, etc.)
 *   before_tool_call { git reset --hard }  → asserts destructiveGit.allow flows
 *                                            through decidePermissionForEvent:
 *                                              allow=true  → allowed (in-workspace)
 *                                              allow=false → blocked
 *
 * Lookup order pinned: workspacePath/WORKFLOW.md → baseRepoPath/WORKFLOW.md →
 * defaults (source:'default'). All via real fs, no mocks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { register, _resetForTest } from '../../index';
import { loadWorkflowConfig, DEFAULT_WORKFLOW_CONFIG } from '../../src/workflow-config';
import type { WorkflowConfig } from '../../src/types';

// ── createMockApi: copied verbatim from tests/plugin-entry.test.ts (proven) ──
function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const hookOpts = new Map<string, { priority?: number; timeoutMs?: number } | undefined>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  let sessionExtension: any = null;
  const injections: any[] = [];
  const enqueueNextTurnInjection = vi.fn(async (injection: any) => {
    injections.push(injection);
    return { enqueued: true, id: `inj-${injections.length}`, sessionKey: injection.sessionKey };
  });
  const registerSessionExtension = vi.fn((ext: any) => { sessionExtension = ext; });
  const session = {
    workflow: { enqueueNextTurnInjection } as { enqueueNextTurnInjection?: typeof enqueueNextTurnInjection },
    state: { registerSessionExtension },
  };
  return {
    api: {
      pluginConfig: {} as Record<string, unknown>,
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number; timeoutMs?: number }) => {
        hooks.set(hookName, handler);
        hookOpts.set(hookName, opts);
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => { gatewayMethods.set(method, handler); }),
      session,
      enqueueNextTurnInjection,
      registerSessionExtension,
    },
    hooks,
    hookOpts,
    gatewayMethods,
    getSessionExtension: () => sessionExtension,
    getInjections: () => injections,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-wf-roundtrip-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a WORKFLOW.md with the given autopilot YAML block into tmpDir. */
function writeWorkflowMd(yamlBlock: string): string {
  const file = path.join(tmpDir, 'WORKFLOW.md');
  fs.writeFileSync(file, `---\n${yamlBlock}\n---\n\n# Workflow\n\nHuman docs.\n`);
  return file;
}

describe('E2E workflow-config round-trip — loadWorkflowConfig (real fs parse + merge)', () => {
  it('parses a full autopilot block → source workflow_md with merged overrides', () => {
    writeWorkflowMd(`autopilot:
  version: 1
  max_concurrent: 8
  max_retries: 5
  stall_timeout_ms: 120000
  max_retry_backoff_ms: 60000
  workspace:
    root: custom-worktrees
    cleanup: delete_on_done
    branch_prefix: custom-prefix
    allow_dirty_base: true
  validation:
    fail_on_optional: true
    commands:
      - id: lint
        command: eslint .
        timeout_ms: 30000
        required: true
      - id: types
        command: tsc --noEmit
  destructive_git:
    allow: true`);

    const { config, warnings } = loadWorkflowConfig(tmpDir);

    expect(config.source).toBe('workflow_md');
    expect(config.maxConcurrent).toBe(8);
    expect(config.maxRetries).toBe(5);
    expect(config.stallTimeoutMs).toBe(120_000);
    expect(config.maxRetryBackoffMs).toBe(60_000);
    // workspace merged over defaults
    expect(config.workspace.root).toBe('custom-worktrees');
    expect(config.workspace.cleanup).toBe('delete_on_done');
    expect(config.workspace.branchPrefix).toBe('custom-prefix');
    expect(config.workspace.allowDirtyBase).toBe(true);
    // validation: both commands parsed, defaults applied where omitted
    expect(config.validation.failOnOptional).toBe(true);
    expect(config.validation.commands).toHaveLength(2);
    expect(config.validation.commands[0]).toEqual({
      id: 'lint', command: 'eslint .', timeoutMs: 30_000, required: true,
    });
    // frozen: types command omits timeout_ms + required → defaults 120000 / true.
    expect(config.validation.commands[1]).toEqual({
      id: 'types', command: 'tsc --noEmit', timeoutMs: 120_000, required: true,
    });
    // destructive_git flows through
    expect(config.destructiveGit.allow).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('partial block → unspecified fields inherit DEFAULT_WORKFLOW_CONFIG', () => {
    writeWorkflowMd(`autopilot:
  version: 1
  destructive_git:
    allow: false`);
    const { config } = loadWorkflowConfig(tmpDir);

    expect(config.source).toBe('workflow_md');
    // Specified value honored
    expect(config.destructiveGit.allow).toBe(false);
    // Unspecified values come from DEFAULT_WORKFLOW_CONFIG (the merge in workflow-config.ts:371-379).
    expect(config.maxConcurrent).toBe(DEFAULT_WORKFLOW_CONFIG.maxConcurrent);
    expect(config.maxRetries).toBe(DEFAULT_WORKFLOW_CONFIG.maxRetries);
    expect(config.workspace.root).toBe(DEFAULT_WORKFLOW_CONFIG.workspace.root);
    expect(config.workspace.cleanup).toBe(DEFAULT_WORKFLOW_CONFIG.workspace.cleanup);
    expect(config.validation.commands).toEqual([]);
  });

  it('missing version → warning emitted, defaults to 1', () => {
    writeWorkflowMd(`autopilot:
  max_concurrent: 3`);
    const { config, warnings } = loadWorkflowConfig(tmpDir);
    // frozen: workflow-config.ts:69 pushes 'Missing version field, defaulting to 1'.
    expect(warnings).toContain('Missing version field, defaulting to 1');
    expect(config.maxConcurrent).toBe(3);
  });

  it('unknown field → warning emitted but parsing continues', () => {
    writeWorkflowMd(`autopilot:
  version: 1
  bogus_field: hello`);
    const { config, warnings } = loadWorkflowConfig(tmpDir);
    expect(warnings.some((w) => w.startsWith('Unknown field:'))).toBe(true);
    expect(config.source).toBe('workflow_md');
  });

  describe('lookup order: workspacePath → baseRepoPath → default', () => {
    it('prefers workspacePath/WORKFLOW.md over baseRepoPath/WORKFLOW.md', () => {
      // baseRepo has allow=true, workspace has allow=false → workspace must win.
      const baseRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-base-'));
      try {
        fs.writeFileSync(
          path.join(baseRepo, 'WORKFLOW.md'),
          '---\nautopilot:\n  version: 1\n  destructive_git:\n    allow: true\n---\n',
        );
        writeWorkflowMd(`autopilot:
  version: 1
  destructive_git:
    allow: false`);

        const { config } = loadWorkflowConfig(baseRepo, tmpDir);
        // workspacePath (tmpDir) wins → allow:false
        expect(config.source).toBe('workflow_md');
        expect(config.destructiveGit.allow).toBe(false);
      } finally {
        fs.rmSync(baseRepo, { recursive: true, force: true });
      }
    });

    it('falls back to baseRepoPath/WORKFLOW.md when workspacePath has none', () => {
      const baseRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-base2-'));
      try {
        fs.writeFileSync(
          path.join(baseRepo, 'WORKFLOW.md'),
          '---\nautopilot:\n  version: 1\n  max_concurrent: 9\n---\n',
        );
        // tmpDir (workspace) has NO WORKFLOW.md → baseRepo must be consulted.
        const { config } = loadWorkflowConfig(baseRepo, tmpDir);
        expect(config.source).toBe('workflow_md');
        expect(config.maxConcurrent).toBe(9);
      } finally {
        fs.rmSync(baseRepo, { recursive: true, force: true });
      }
    });

    it('returns DEFAULT_WORKFLOW_CONFIG (source: default) when no WORKFLOW.md anywhere', () => {
      // tmpDir is empty (only the mkdtemp dir exists, no WORKFLOW.md).
      const { config, warnings } = loadWorkflowConfig(tmpDir);
      expect(config.source).toBe('default');
      expect(config).toEqual(DEFAULT_WORKFLOW_CONFIG);
      expect(warnings).toEqual([]);
    });

    it('file without autopilot: section → falls through to default', () => {
      // A WORKFLOW.md that has front matter but no autopilot key.
      fs.writeFileSync(
        path.join(tmpDir, 'WORKFLOW.md'),
        `---\ntitle: My Workflow\n---\n\n# Just docs\n`,
      );
      const { config } = loadWorkflowConfig(tmpDir);
      // frozen: workflow-config.ts:352-355 `continue`s on no-autopilot files,
      // falling through to default config (source:'default').
      expect(config.source).toBe('default');
    });
  });
});

/**
 * Full integration through the PUBLIC register() API:
 *   activate { workspacePath }  →  state.workflow stored
 *   status                      →  projection exposes parsed workflow
 *
 * This proves the wiring from index.ts:834-861 (applyWorkflowConfig) round-trips
 * a real WORKFLOW.md into the live run state that every downstream consumer
 * (evidence gate, permission gate) reads.
 */
describe('E2E register() → activate → state.workflow round-trip', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
  });

  async function activateWithWorkspace(sessionKey: string, workspacePath: string, trustWorkspace?: boolean) {
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    const respond = vi.fn();
    await activateHandler({ params: { sessionKey, workspacePath, ...(trustWorkspace !== undefined ? { trustWorkspace } : {}) }, respond });
    expect(respond.mock.calls[0][0]).toBe(true);
    // session_start maps sessionId→sessionKey (mirrors plugin-entry.test.ts pattern)
    const sessionStartHandler = mock.hooks.get('session_start')!;
    await sessionStartHandler({ sessionId: `sid-${sessionKey}`, sessionKey });
  }

  async function getStatusWorkflow(sessionKey: string): Promise<WorkflowConfig | undefined> {
    const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
    const respond = vi.fn();
    await statusHandler({ params: { sessionKey }, respond });
    return respond.mock.calls[0][1]?.workflow as WorkflowConfig | undefined;
  }

  it('activate with WORKFLOW.md workspacePath → state.workflow.source === workflow_md', async () => {
    writeWorkflowMd(`autopilot:
  version: 1
  max_concurrent: 7
  destructive_git:
    allow: true`);
    await activateWithWorkspace('wf-sess-1', tmpDir);
    const workflow = await getStatusWorkflow('wf-sess-1');

    expect(workflow).toBeDefined();
    expect(workflow!.source).toBe('workflow_md');
    expect(workflow!.maxConcurrent).toBe(7);
    expect(workflow!.destructiveGit.allow).toBe(true);
  });

  it('activate WITHOUT WORKFLOW.md → state.workflow is the DEFAULT config (source: default)', async () => {
    // tmpDir is empty.
    await activateWithWorkspace('wf-sess-2', tmpDir);
    const workflow = await getStatusWorkflow('wf-sess-2');

    expect(workflow).toBeDefined();
    expect(workflow!.source).toBe('default');
    expect(workflow!.validation.commands).toEqual([]);
    expect(workflow!.destructiveGit.allow).toBe(false);
  });

  it('validation commands reach state.workflow when trustWorkspace:true (consumed by evidence gate)', async () => {
    // S1 + S1-residual A: the binary must be allowlisted (echo → eslint), AND the
    // operator must opt in via trustWorkspace:true — otherwise workspace-sourced
    // validation commands are not loaded (untrusted-workspace RCE boundary).
    writeWorkflowMd(`autopilot:
  version: 1
  validation:
    commands:
      - id: lint
        command: eslint .
        required: true`);
    await activateWithWorkspace('wf-sess-3', tmpDir, true);
    const workflow = await getStatusWorkflow('wf-sess-3');

    // These are the exact commands index.ts reads at complete-time to feed
    // runValidationCommands. Pinning them here guards the evidence-gate wiring.
    expect(workflow!.validation.commands).toHaveLength(1);
    expect(workflow!.validation.commands[0]).toEqual({
      id: 'lint', command: 'eslint .', timeoutMs: 120_000, required: true,
    });
  });

  it('S1-residual A: default (trustWorkspace unset) → validation commands empty + warning', async () => {
    // Untrusted workspace: even with an allowlisted command in WORKFLOW.md, the
    // commands are NOT loaded — the operator has not opted in, so the would-be
    // RCE path (workspace-controlled validation execution) stays closed.
    writeWorkflowMd(`autopilot:
  version: 1
  validation:
    commands:
      - id: lint
        command: eslint .
        required: true`);
    await activateWithWorkspace('wf-sess-3b', tmpDir);
    const workflow = await getStatusWorkflow('wf-sess-3b');
    expect(workflow!.validation.commands).toHaveLength(0);
    expect(workflow!.warnings.some((w) => w.includes('untrusted workspace'))).toBe(true);
  });

  it('S1-residual A: payload trustWorkspace:false overrides pluginConfig trustWorkspace:true', async () => {
    // Guards the ?? chain (payload ?? config ?? false): an explicit `false` must
    // win over a pluginConfig `true`. A mistaken `||` would treat false as falsy
    // and fall through to the trusted config — re-opening the RCE surface.
    _resetForTest();
    const trustedMock = createMockApi();
    (trustedMock.api as { pluginConfig: Record<string, unknown> }).pluginConfig = { trustWorkspace: true };
    register(trustedMock.api as unknown as Parameters<typeof register>[0]);
    writeWorkflowMd(`autopilot:
  version: 1
  validation:
    commands:
      - id: lint
        command: eslint .
        required: true`);
    const activateHandler = trustedMock.gatewayMethods.get('autopilot.activate')!;
    const respond = vi.fn();
    await activateHandler({ params: { sessionKey: 'wf-sess-false', workspacePath: tmpDir, trustWorkspace: false }, respond });
    await trustedMock.hooks.get('session_start')!({ sessionId: 'sid-false', sessionKey: 'wf-sess-false' });

    const statusHandler = trustedMock.gatewayMethods.get('autopilot.status')!;
    const srespond = vi.fn();
    await statusHandler({ params: { sessionKey: 'wf-sess-false' }, respond: srespond });
    const wf = srespond.mock.calls[0][1]?.workflow as WorkflowConfig | undefined;
    // Explicit false wins → commands empty despite pluginConfig:true.
    expect(wf!.validation.commands).toHaveLength(0);
    expect(wf!.warnings.some((w) => w.includes('untrusted workspace'))).toBe(true);
  });
});

/**
 * destructiveGit.allow → permission decision flow-through.
 *
 * Drives the REAL before_tool_call hook (registered by register()) with a
 * `git reset --hard` command and asserts:
 *   allow=true  + cwd in-workspace → outcome allow (no block)
 *   allow=false                   → outcome block (destructive git vetoed)
 *
 * This is the full permission-policy chain: index.ts:558 builds the decision
 * via decidePermissionForEvent({ workflowAllowsDestructiveGit: state.workflow... }),
 * which flows into permission-policy.ts:344-376. cwd is the workspace path so
 * the in-workspace containment check passes when allow=true.
 */
describe('E2E destructiveGit.allow → before_tool_call permission decision', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
  });

  async function activateWithDestructiveGit(sessionKey: string, allow: boolean) {
    writeWorkflowMd(`autopilot:
  version: 1
  destructive_git:
    allow: ${allow}`);
    const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
    const respond = vi.fn();
    await activateHandler({ params: { sessionKey, workspacePath: tmpDir }, respond });
    expect(respond.mock.calls[0][0]).toBe(true);
    const sessionStartHandler = mock.hooks.get('session_start')!;
    await sessionStartHandler({ sessionId: `sid-${sessionKey}`, sessionKey });
  }

  /** Invoke the before_tool_call hook for a session; return its block/allow result. */
  function fireToolCall(sessionKey: string, command: string): { block?: boolean } | undefined {
    const handler = mock.hooks.get('before_tool_call')!;
    return handler(
      { toolName: 'bash', params: { command, workdir: tmpDir } },
      { sessionKey },
    ) as { block?: boolean } | undefined;
  }

  it('allow=true + cwd in workspace → destructive git ALLOWED', async () => {
    await activateWithDestructiveGit('dg-allow', true);
    // git reset --hard classifies as destructive_git (permission-policy.ts:210).
    const result = fireToolCall('dg-allow', 'git reset --hard origin/main');

    // No block returned → the hook allowed it (decidePermissionForEvent returned
    // outcome:'allow' because workflowAllowsDestructiveGit + cwd contained in workspace).
    expect(result?.block).toBeFalsy();
  });

  it('allow=false → destructive git BLOCKED (hard veto)', async () => {
    await activateWithDestructiveGit('dg-block', false);
    const result = fireToolCall('dg-block', 'git reset --hard origin/main');

    // frozen: permission-policy.ts:371-375 returns outcome:'block' with message.
    // index.ts:620-625 turns that into { block: true, blockReason }.
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(typeof (result as { blockReason?: string }).blockReason).toBe('string');
  });

  it('allow=true but a SAFE git command is still allowed (classification unaffected)', async () => {
    await activateWithDestructiveGit('dg-safe', true);
    // git status is safe_git (not destructive) → allow regardless of destructiveGit flag.
    const result = fireToolCall('dg-safe', 'git status');
    expect(result?.block).toBeFalsy();
  });
});
