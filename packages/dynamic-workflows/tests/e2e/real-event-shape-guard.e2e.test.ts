/**
 * E2E: the dynamic-workflows subagent guard against the REAL OpenClaw event
 * shape. This is the in-repo proxy for the host-repo deployed-dist verify-guard
 * (see docs/fixes/runtime-guard-event-shape.md).
 *
 * INCREMENTAL over tests/subagent-guard.test.ts (which already covers priority,
 * &&/& chaining, defaultDeny, highRiskTools, enabled=false). This suite adds:
 *  1. The VERBATIM live-captured event from the fix doc (the ground truth the
 *     fictional-shape tests lacked) — both the allow case and the production
 *     bug case (git reset --hard in that exact shape).
 *  2. The full operator matrix (|| ; | \n) THROUGH the registered hook — the
 *     existing test only exercises && and &.
 *  3. The audit-on-block DISK side effect — a block writes a real JSONL entry.
 *
 * Events use ONLY the real shape {toolName, params:{command?, workdir?}, runId,
 * toolCallId} — never the fictional {toolKind, args} that green-lit the
 * 2026-06-28 fail-open bug.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { register, _resetForTest } from '../../index';
import { loadRecentAuditEntries } from '@oh-my-matrix/permission-policy';

const SUBAGENT_KEY = 'agent:main:subagent:b9b3d8fc-ad1c-48d9-87de-b51db969e804';

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const hookOpts = new Map<string, { priority?: number } | undefined>();
  const api = {
    pluginConfig,
    on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => {
      hooks.set(hookName, handler);
      hookOpts.set(hookName, opts);
    },
  };
  return { api, hooks, hookOpts };
}

describe('E2E real-event-shape guard — dynamic-workflows', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as never);
  });

  describe('verbatim live-captured event (ground truth from the fix doc)', () => {
    // The exact shape captured 2026-06-28: top-level keys toolName/params/runId/toolCallId only.
    let ws: string;
    beforeEach(() => {
      ws = mkdtempSync(join(tmpdir(), 'dw-e2e-'));
    });
    afterEach(() => {
      rmSync(ws, { recursive: true, force: true });
    });

    it('ALLOWS the captured `git status` event (the real subagent shape)', async () => {
      const h = mock.hooks.get('before_tool_call')!;
      const result = await h(
        {
          toolName: 'exec',
          params: { command: `cd ${ws} && git status 2>&1`, workdir: ws },
          runId: 'b7fc1214-b67e-4317-9232-5b573e189d9a',
          toolCallId: 'call_019f0bc72adf7c10883b0dad',
        },
        { sessionKey: SUBAGENT_KEY },
      );
      expect(result).toBeUndefined(); // undefined = pass/allow
    });

    it('BLOCKS `git reset --hard` in that exact real shape (the production bug)', async () => {
      const h = mock.hooks.get('before_tool_call')!;
      const result = (await h(
        {
          toolName: 'exec',
          params: { command: `cd ${ws} && git reset --hard HEAD~1 2>&1`, workdir: ws },
          runId: 'b7fc1214-b67e-4317-9232-5b573e189d9a',
          toolCallId: 'call_019f0bc72adf7c10883b0dad',
        },
        { sessionKey: SUBAGENT_KEY },
      )) as { block?: boolean; blockReason?: string };
      expect(result.block).toBe(true);
      expect(result.blockReason).toBeDefined();
    });
  });

  describe('full shell-operator matrix THROUGH the registered hook', () => {
    // Existing subagent-guard.test.ts covers && and single-&; this fills || ; | \n.
    it.each([
      ['echo hi || git reset --hard', '||'],
      ['echo hi; rm -rf /', ';'],
      ['echo hi | git clean -fdx', '| (pipe)'],
      ['echo hi\nrm -rf /', '\\n (newline)'],
    ] as const)('BLOCKS destructive tail via %s: "%s"', async (command, _op) => {
      const h = mock.hooks.get('before_tool_call')!;
      const result = (await h(
        { toolName: 'exec', params: { command } },
        { sessionKey: SUBAGENT_KEY },
      )) as { block?: boolean };
      expect(result.block).toBe(true);
    });
  });

  describe('SEC-5 git global-flag evasion THROUGH the registered hook', () => {
    // The unit suite (permission-policy.test.ts) covers classifyCommand directly:
    // it strips `git -c/-C/--work-tree/--git-dir/--namespace/--exec-path/--config-env`
    // (and boolean flags --bare/-p/--no-pager/...) before the subcommand so the real
    // destructive verb classifies as 'destructive_git', not 'unknown'.
    //
    // This block fills the E2E gap (issue #51 item 3): the SAME payloads must
    // classify as 'destructive_git' (NOT 'unknown') when they travel the FULL
    // before_tool_call → decidePermissionForEvent → extractCommandSegments →
    // tokenizeShell → classifyCommand path with a real {toolName, params:{command}}
    // event. A wiring regression (e.g. params.command not reaching classifyCommand,
    // like the 2026-06-28 event.args fail-open) would flip these to 'unknown'.
    //
    // CRITICAL — why we assert blockReason, not just block: the subagent path runs
    // with defaultDeny:true, so 'unknown' ALSO blocks (via "not on the allowlist for
    // subagent sessions"). Both 'destructive_git' and 'unknown' → block. To actually
    // pin SEC-5 we assert the block came via the DESTRUCTIVE-GIT path (message:
    // "Destructive git commands are blocked"), which is only reached when the global
    // flag is stripped. If SEC-5 regresses, the same payload blocks via the unknown/
    // defaultDeny path with a DIFFERENT message, failing this test.
    it.each([
      ['git --git-dir=/evil reset --hard', '--git-dir= (attached)'],
      ['git --git-dir /evil reset --hard', '--git-dir (space-form)'],
      ['git --work-tree=/sensitive clean -fdx', '--work-tree= (attached)'],
      ['git --work-tree /sensitive push --force', '--work-tree (space-form)'],
      ['git --namespace=ns reset --hard', '--namespace= (attached)'],
      ['git --exec-path=/evil reset --hard', '--exec-path= (attached)'],
      ['git --config-env=HOME=X reset --hard', '--config-env= (attached)'],
      ['git -c key=val reset --hard', '-c key=val'],
      ['git --bare reset --hard', '--bare (boolean)'],
      ['git -p reset --hard', '-p (boolean, short)'],
      ['git --no-pager reset --hard', '--no-pager (boolean)'],
      // Combined: a stack of global flags (= and -c forms) must all strip before
      // the destructive verb. No -C/path form (would set cwd to a stray path and
      // muddy the audit side effect); stacked =/-c forms keep cwd clean.
      ['git --work-tree=/a -c k=v --git-dir=/c reset --hard', 'stacked global flags'],
    ] as const)('classifies global-flag-masked git as destructive_git (not unknown): "%s"', async (command) => {
      const h = mock.hooks.get('before_tool_call')!;
      const result = (await h(
        { toolName: 'exec', params: { command } },
        { sessionKey: SUBAGENT_KEY },
      )) as { block?: boolean; blockReason?: string };
      expect(result.block).toBe(true);
      // Pins SEC-5: the block must come from the destructive_git classification,
      // NOT the defaultDeny 'unknown' path. See the comment above for why this
      // distinction matters under defaultDeny:true.
      expect(result.blockReason).toBe('Destructive git commands are blocked');
    });
  });

  describe('audit-on-block DISK side effect', () => {
    let ws: string;
    beforeEach(() => {
      ws = mkdtempSync(join(tmpdir(), 'dw-audit-'));
    });
    afterEach(() => {
      rmSync(ws, { recursive: true, force: true });
    });

    it('a blocked destructive call appends a real JSONL audit entry to the workspace', async () => {
      const h = mock.hooks.get('before_tool_call')!;
      // workdir controls where appendAuditEntry writes (cwd = params.workdir).
      await h(
        { toolName: 'exec', params: { command: 'git reset --hard HEAD~1', workdir: ws } },
        { sessionKey: SUBAGENT_KEY },
      );
      const entries = loadRecentAuditEntries(ws, 5);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const last = entries[entries.length - 1];
      expect(last.outcome).toBe('block');
      expect(last.toolName).toBe('exec');
      expect(last.commandClass).toBe('destructive_git');
      expect(last.runId).toContain('subagent:');
    });
  });
});
