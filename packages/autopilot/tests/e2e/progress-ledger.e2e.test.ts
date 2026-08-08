/**
 * E2E: E5 progress ledger wiring — after_tool_call is the SOLE source of
 * filesTouched/commandsRun, exec-only (read-only excluded), and subagent
 * activity merges up to the parent run.
 *
 * Drives register() + the registered hooks. Asserts via the agent_turn_prepare
 * injection (which surfaces summarizeLedger(state.ledger)).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register, _resetForTest } from '../../index';

function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => any>();
  const gatewayMethods = new Map<string, (...args: unknown[]) => any>();
  const session = {
    workflow: { enqueueNextTurnInjection: vi.fn(async () => ({ enqueued: true })) },
    state: { registerSessionExtension: vi.fn() },
  };
  return {
    api: {
      pluginConfig: {},
      session,
      on: vi.fn((h: string, fn: (...a: unknown[]) => unknown) => { hooks.set(h, fn); }),
      registerGatewayMethod: vi.fn((m: string, fn: any) => { gatewayMethods.set(m, fn); }),
    } as any,
    hooks, gatewayMethods,
  };
}

async function activate(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  await mock.gatewayMethods.get('autopilot.activate')!({ params: { sessionKey }, respond: vi.fn() });
  await mock.hooks.get('session_start')!({ sessionId: `sid-${sessionKey}`, sessionKey });
  mock.hooks.get('agent_turn_prepare')!({ prompt: 'do the work' }, { sessionKey });
}

function injectionFor(mock: ReturnType<typeof createMockApi>, sessionKey: string): string {
  const r = mock.hooks.get('agent_turn_prepare')!({ prompt: 'continue' }, { sessionKey }) as { appendContext?: string };
  return r?.appendContext ?? '';
}

describe('E2E: E5 progress ledger wiring', () => {
  let mock: ReturnType<typeof createMockApi>;
  beforeEach(() => { _resetForTest(); mock = createMockApi(); register(mock.api); });

  it('filesTouched come from write tools only; commandsRun from exec; read-only records nothing', async () => {
    await activate(mock, 'sess-ledger');

    const afterTool = mock.hooks.get('after_tool_call')!;
    // write tool → file
    afterTool({ toolName: 'write_file', params: { file_path: 'src/a.ts' } }, { sessionKey: 'sess-ledger' });
    // read tool → must NOT be recorded
    afterTool({ toolName: 'read_file', params: { file_path: 'src/b.ts' } }, { sessionKey: 'sess-ledger' });
    // exec tool → command
    afterTool({ toolName: 'bash', params: { command: 'npm test' } }, { sessionKey: 'sess-ledger' });

    // finalize the turn
    await mock.hooks.get('before_agent_finalize')!({
      sessionId: 'sid-sess-ledger', sessionKey: 'sess-ledger', lastAssistantMessage: 'working', stopHookActive: false,
    });
    await mock.hooks.get('agent_end')!({ sessionId: 'sid-sess-ledger', sessionKey: 'sess-ledger', success: true });

    const inj = injectionFor(mock, 'sess-ledger');
    expect(inj).toContain('Progress ledger');
    expect(inj).toContain('src/a.ts');      // write tool recorded
    expect(inj).toContain('npm test');      // exec tool recorded
    expect(inj).not.toContain('src/b.ts');  // read-only excluded
  });

  it('subagent tool activity merges up to the parent run (observation only)', async () => {
    // Parent key must match the prefix extractParentSessionKey derives from the
    // subagent key: 'agent:X:subagent:Y' -> 'agent:X'.
    const parent = 'agent:sess-parent';
    const sub = 'agent:sess-parent:subagent:task-1';
    await activate(mock, parent);

    const afterTool = mock.hooks.get('after_tool_call')!;
    // tool call from the SUBAGENT session key — must attribute to the parent run
    afterTool({ toolName: 'write_file', params: { file_path: 'src/from-sub.ts' } }, { sessionKey: sub });

    await mock.hooks.get('before_agent_finalize')!({
      sessionId: 'sid-sess-parent', sessionKey: parent, lastAssistantMessage: 'working', stopHookActive: false,
    });
    await mock.hooks.get('agent_end')!({ sessionId: 'sid-sess-parent', sessionKey: parent, success: true });

    const inj = injectionFor(mock, parent);
    expect(inj).toContain('src/from-sub.ts'); // subagent activity attributed to parent
  });

  it('replaces the Turn N/M counter — no "completed" counter in the injection', async () => {
    await activate(mock, 'sess-counter');
    await mock.hooks.get('before_agent_finalize')!({
      sessionId: 'sid-sess-counter', sessionKey: 'sess-counter', lastAssistantMessage: 'working', stopHookActive: false,
    });
    await mock.hooks.get('agent_end')!({ sessionId: 'sid-sess-counter', sessionKey: 'sess-counter', success: true });
    const inj = injectionFor(mock, 'sess-counter');
    expect(inj).toContain('Progress ledger');
    expect(inj).not.toMatch(/Turn \d+\/\d+ completed/);
  });

  it('batch write tool with an array of file paths records each (review follow-up)', async () => {
    await activate(mock, 'sess-batch');
    mock.hooks.get('after_tool_call')!({ toolName: 'write_file', params: { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] } }, { sessionKey: 'sess-batch' });
    await mock.hooks.get('before_agent_finalize')!({
      sessionId: 'sid-sess-batch', sessionKey: 'sess-batch', lastAssistantMessage: 'working', stopHookActive: false,
    });
    await mock.hooks.get('agent_end')!({ sessionId: 'sid-sess-batch', sessionKey: 'sess-batch', success: true });
    const inj = injectionFor(mock, 'sess-batch');
    expect(inj).toContain('src/a.ts');
    expect(inj).toContain('src/c.ts');
  });

  it('degraded agent_end (no before_agent_finalize) still records the turn + clears the accumulator', async () => {
    // Review #1/#12: the degraded (!didFire) path used to return before finalizing
    // the ledger, leaking turnAccumulator and collapsing turns. Now the ledger is
    // finalized once at the top of agent_end — degraded turns are recorded too.
    await activate(mock, 'sess-degraded');
    // NOTE: deliberately NO before_agent_finalize → canary never fires → degraded.
    mock.hooks.get('after_tool_call')!({ toolName: 'write_file', params: { file_path: 'src/d.ts' } }, { sessionKey: 'sess-degraded' });
    await mock.hooks.get('agent_end')!({ sessionId: 'sid-sess-degraded', sessionKey: 'sess-degraded', success: true });
    const inj = injectionFor(mock, 'sess-degraded');
    expect(inj).toContain('src/d.ts'); // degraded turn's work recorded
  });

  it('a read-only payload via a generic exec tool records nothing (review follow-up)', async () => {
    // Review #6: `bash cat x` must classify read_only (via tokenized args) and
    // record nothing — preserving the read-only invariant for the E6 signal.
    await activate(mock, 'sess-ro');
    mock.hooks.get('after_tool_call')!({ toolName: 'bash', params: { command: 'cat src/readonly.ts' } }, { sessionKey: 'sess-ro' });
    await mock.hooks.get('before_agent_finalize')!({
      sessionId: 'sid-sess-ro', sessionKey: 'sess-ro', lastAssistantMessage: 'working', stopHookActive: false,
    });
    await mock.hooks.get('agent_end')!({ sessionId: 'sid-sess-ro', sessionKey: 'sess-ro', success: true });
    const inj = injectionFor(mock, 'sess-ro');
    expect(inj).not.toContain('readonly.ts');
    expect(inj).not.toContain('cat src');
  });
});
