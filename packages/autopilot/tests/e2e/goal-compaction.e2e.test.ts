/**
 * E2E: goal preservation across the compaction seam.
 *
 * Asserts the before_compaction / after_compaction / agent_turn_prepare cycle:
 *   1. a goal captured from the first prompt survives a simulated compaction
 *      (before_compaction snapshots goal/progress, after_compaction restores +
 *      clears the snapshot),
 *   2. agent_turn_prepare re-injects the goal via appendContext after compaction
 *      (the goalSnapshot-cleared state re-enables injection), and
 *   3. the goal is observable in projection.lastGoal throughout.
 *
 * CODE is truth — flow verified in:
 *   - index.ts:457-475  before_compaction → preserveGoalBeforeCompaction
 *   - index.ts:467-475  after_compaction  → restoreGoalAfterCompaction
 *   - index.ts:477-536  agent_turn_prepare → captureGoal + appendContext injection
 *                        (+ effort injection via buildEffortInjection)
 *   - goal-manager.ts   snapshotGoal / restoreGoalFromSnapshot
 *   - autopilot-state.ts snapshotGoal sets goalSnapshot, clears on restore
 *
 * Imports from ../src and ../index (no build step).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { register, _resetForTest } from '../../index';

function createMockApi() {
  const hooks = new Map<string, (...args: unknown[]) => any>();
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
      on: vi.fn((hookName: string, handler: (...args: unknown[]) => unknown) => {
        hooks.set(hookName, handler);
      }),
      registerGatewayMethod: vi.fn((method: string, handler: any) => {
        gatewayMethods.set(method, handler);
      }),
      session,
      enqueueNextTurnInjection,
      registerSessionExtension,
    },
    hooks,
    gatewayMethods,
    getSessionExtension: () => sessionExtension,
    getInjections: () => injections,
  };
}

async function readProjection(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const statusHandler = mock.gatewayMethods.get('autopilot.status')!;
  const respond = vi.fn();
  await statusHandler({ params: { sessionKey }, respond });
  return respond.mock.calls[0][1]?.projection;
}

async function activate(mock: ReturnType<typeof createMockApi>, sessionKey: string) {
  const activateHandler = mock.gatewayMethods.get('autopilot.activate')!;
  await activateHandler({ params: { sessionKey }, respond: vi.fn() });
  const sessionStartHandler = mock.hooks.get('session_start')!;
  await sessionStartHandler({ sessionId: `sid-${sessionKey}`, sessionKey });
}

describe('E2E: goal preservation across the compaction seam (T17)', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as any);
  });

  it('goal captured from first prompt is observable in projection.lastGoal', async () => {
    await activate(mock, 'sess-g1');
    const atp = mock.hooks.get('agent_turn_prepare')!;
    atp({ prompt: '帮我重构 auth 模块并添加单元测试' }, { sessionKey: 'sess-g1' });

    const proj = await readProjection(mock, 'sess-g1');
    // lastGoal truncates to 100 chars (projection.ts:70); goal fits.
    expect(proj.lastGoal).toContain('重构 auth 模块');
  });

  it('goal survives a simulated compaction cycle and stays in projection.lastGoal', async () => {
    await activate(mock, 'sess-g2');
    const atp = mock.hooks.get('agent_turn_prepare')!;
    const beforeCompaction = mock.hooks.get('before_compaction')!;
    const afterCompaction = mock.hooks.get('after_compaction')!;

    // 1. capture goal
    atp({ prompt: '实现用户登录与权限校验' }, { sessionKey: 'sess-g2' });
    const projBefore = await readProjection(mock, 'sess-g2');
    expect(projBefore.lastGoal).toContain('用户登录与权限校验');

    // 2. simulate compaction seam: snapshot → restore
    beforeCompaction({ sessionKey: 'sess-g2' });
    afterCompaction({ sessionKey: 'sess-g2' });

    // 3. goal still present after restore
    const projAfter = await readProjection(mock, 'sess-g2');
    expect(projAfter.lastGoal).toContain('用户登录与权限校验');
  });

  it('agent_turn_prepare re-injects the goal via appendContext after compaction restores', async () => {
    await activate(mock, 'sess-g3');
    const atp = mock.hooks.get('agent_turn_prepare')!;
    const beforeCompaction = mock.hooks.get('before_compaction')!;
    const afterCompaction = mock.hooks.get('after_compaction')!;

    // capture goal on first turn (also produces an appendContext injection)
    const first = atp({ prompt: '完成数据库迁移脚本' }, { sessionKey: 'sess-g3' });
    expect(first).toBeDefined();
    expect(first.appendContext).toContain('完成数据库迁移脚本');

    // simulate compaction
    beforeCompaction({ sessionKey: 'sess-g3' });
    afterCompaction({ sessionKey: 'sess-g3' });

    // post-compaction turn: snapshot was cleared by restore, so injection fires again
    const postCompaction = atp({ prompt: '继续' }, { sessionKey: 'sess-g3' });
    expect(postCompaction).toBeDefined();
    expect(postCompaction.appendContext).toContain('完成数据库迁移脚本');
  });

  it('re-injected appendContext includes the effort-injection + completion-awareness lines', async () => {
    // frozen to current behavior:
    //   - buildEffortInjection('running') → '[autopilot-effort] Use high effort ...'
    //   - index.ts:533 appends '[Autopilot] When all tasks are complete, explicitly state "All tasks completed".'
    await activate(mock, 'sess-g4');
    const atp = mock.hooks.get('agent_turn_prepare')!;
    const beforeCompaction = mock.hooks.get('before_compaction')!;
    const afterCompaction = mock.hooks.get('after_compaction')!;

    atp({ prompt: '修复 CI 失败' }, { sessionKey: 'sess-g4' });
    beforeCompaction({ sessionKey: 'sess-g4' });
    afterCompaction({ sessionKey: 'sess-g4' });

    const result = atp({ prompt: '继续' }, { sessionKey: 'sess-g4' });
    expect(result).toBeDefined();
    // effort injection present (status === 'running')
    expect(result.appendContext).toContain('[autopilot-effort]');
    expect(result.appendContext).toContain('high effort');
    // completion-awareness instruction present
    expect(result.appendContext).toContain('All tasks completed');
    // goal line present
    expect(result.appendContext).toContain('Current goal: 修复 CI 失败');
  });

  it('before_compaction is a no-op when no goal has been captured', async () => {
    // goal-manager.preserveGoalBeforeCompaction returns state unchanged when !state.goal
    await activate(mock, 'sess-g5');
    const beforeCompaction = mock.hooks.get('before_compaction')!;
    const afterCompaction = mock.hooks.get('after_compaction')!;

    // no agent_turn_prepare → no goal captured
    beforeCompaction({ sessionKey: 'sess-g5' });
    afterCompaction({ sessionKey: 'sess-g5' });

    const proj = await readProjection(mock, 'sess-g5');
    // running, no goal — lastGoal undefined
    expect(proj.status).toBe('running');
    expect(proj.lastGoal).toBeUndefined();
  });

  it('compaction seam preserves goal when goal would otherwise be lost (restore-from-snapshot)', async () => {
    // This is the core invariant: restoreGoalAfterCompaction sets
    //   goal = state.goal ?? state.goalSnapshot
    // so even if something cleared state.goal mid-seam, the snapshot restores it.
    await activate(mock, 'sess-g6');
    const atp = mock.hooks.get('agent_turn_prepare')!;
    const beforeCompaction = mock.hooks.get('before_compaction')!;
    const afterCompaction = mock.hooks.get('after_compaction')!;

    atp({ prompt: '编写 API 文档' }, { sessionKey: 'sess-g6' });
    const proj1 = await readProjection(mock, 'sess-g6');
    expect(proj1.lastGoal).toBe('编写 API 文档');

    // snapshot copies goal → goalSnapshot
    beforeCompaction({ sessionKey: 'sess-g6' });
    // restore: goal = goal ?? goalSnapshot (goal still set, so unchanged); clears snapshot
    afterCompaction({ sessionKey: 'sess-g6' });

    // goal observable post-compaction
    const proj2 = await readProjection(mock, 'sess-g6');
    expect(proj2.lastGoal).toBe('编写 API 文档');

    // and agent_turn_prepare still injects it
    const result = atp({ prompt: '继续' }, { sessionKey: 'sess-g6' });
    expect(result.appendContext).toContain('编写 API 文档');
  });
});
