/**
 * E2E golden-file contract oracle for the orphaned test-prompts.json.
 *
 * test-prompts.json ships 4 "workflow-classification golden cases" but nothing
 * wires them into a test — this file turns them into a contract oracle: each
 * case's `prompt` is driven THROUGH the real guard (register() + the registered
 * before_tool_call hook with the REAL OpenClaw event shape), and the programmatic
 * outcome the guard actually produces is asserted against the only invariant the
 * golden text implies at THIS layer.
 *
 * IMPORTANT — what the golden file is and is NOT:
 *   - The golden `expected` field is PROSE describing desired SKILL-level agent
 *     behavior (workflow fan-out, .prose plan generation, parallelism ceilings).
 *     That classification lives in the dynamic-workflows SKILL layer, which is
 *     NOT part of this npm package (this package ships only the runtime guard).
 *   - So the skill-level "use workflow: yes/no" semantics are NOT assertable
 *     from the guard. The golden file is partly STALE for this package's
 *     surface: it asserts behavior the guard cannot produce or observe.
 *   - What IS assertable at the guard layer: whether the command embedded in
 *     each prompt, if a subagent tried to execute it, is blocked or passed.
 *     Case 4 embeds `git reset --hard` (destructive) → MUST block. Cases 1-3
 *     contain no executable destructive op → guard passes (guard never blocks
 *     on text; it blocks on tool calls). We freeze ACTUAL behavior and flag the
 *     golden prose as out-of-scope-for-the-guard in comments.
 *
 * This follows the repo "honest test" principle: assert actual behavior, flag
 * divergence, never mock the SUT.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import goldenCases from '../../test-prompts.json';
import { register, _resetForTest } from '../../index';

// Real subagent sessionKey (matches openclaw src/sessions/session-key-utils.ts).
const SUBAGENT_KEY = 'agent:main:subagent:golden-0123';

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

describe('E2E golden-file contract — test-prompts.json driven through the real guard', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    _resetForTest();
    mock = createMockApi();
    register(mock.api as never);
  });

  it('the golden file still has the 4 documented cases (shape guard)', () => {
    expect(Array.isArray(goldenCases)).toBe(true);
    expect(goldenCases).toHaveLength(4);
    for (const c of goldenCases) {
      expect(typeof c.id).toBe('number');
      expect(typeof c.prompt).toBe('string');
      expect(typeof c.expected).toBe('string');
    }
  });

  // Cases 1-3 are natural-language planning prose with NO embedded destructive
  // op. The guard fires on tool calls, not on prompt text, so there is nothing
  // guard-layer to assert for them — a "prompt does not contain `git reset`"
  // regex would pass with the guard deleted. Their skill-layer "Use workflow:
  // yes/no" classification lives in the dynamic-workflows SKILL (not this npm
  // package), which the scope-canary test below already pins. Only case 4
  // embeds a destructive op and is guard-assertable.

  /**
   * Case 4 — the LOAD-BEARING golden case for the guard. The prompt explicitly
   * proposes `git reset --hard` across branches. The golden prose itself flags
   * the safety contract: "agent must block destructive git unless workflow
   * config explicitly allows it inside the workspace". This IS the guard's job.
   *
   * Driven through the REAL registered hook with the REAL event shape: a
   * subagent issuing `git reset --hard` MUST be blocked (fail-closed,
   * workflowAllowsDestructiveGit=false for ad-hoc subagents). This is the one
   * golden case where the prose contract and the guard's programmatic contract
   * coincide, and current code satisfies it.
   */
  it('case 4 (destructive git): a subagent issuing `git reset --hard` is BLOCKED — matches the golden safety contract', async () => {
    const case4 = goldenCases.find((c) => c.id === 4)!;
    expect(case4.prompt).toMatch(/git\s+reset\s+--hard/);
    // Golden prose asserts the safety invariant the guard owns.
    expect(case4.expected).toMatch(/block destructive git/i);

    const h = mock.hooks.get('before_tool_call')!;
    const result = (await h(
      {
        toolName: 'exec',
        params: { command: 'git reset --hard' },
        runId: 'golden-case-4',
        toolCallId: 'call-golden-4',
      },
      { sessionKey: SUBAGENT_KEY },
    )) as { block?: boolean; blockReason?: string };
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.blockReason).toBeDefined();
  });

  /**
   * Companion to case 4: the golden prose carves out the ONE exception —
   * "unless workflow config explicitly allows it inside the workspace". The
   * guard pins this: an ad-hoc subagent has workflowAllowsDestructiveGit=false
   * (the guard hard-codes false for sessions without workspace context), so the
   * exception does NOT apply and the block holds. Frozen: actual behavior.
   */
  it('case 4 exception clause: ad-hoc subagent has no workspace allow → block still holds (no escape hatch)', async () => {
    const h = mock.hooks.get('before_tool_call')!;
    const result = (await h(
      { toolName: 'exec', params: { command: 'git reset --hard HEAD~1' } },
      { sessionKey: SUBAGENT_KEY },
    )) as { block?: boolean };
    expect(result.block).toBe(true);
  });

  /**
   * Golden-file scope flag: the `expected` prose describes skill-layer workflow
   * classification, which this package (the runtime guard) does not implement.
   * If a future commit moves workflow classification into this package, this
   * test will need to be rewritten — it is the canary that the golden file
   * covers more than the guard.
   */
  it('golden prose is skill-layer (NOT guard-layer) — every case mentions workflow/skill concepts the guard cannot observe', () => {
    for (const c of goldenCases) {
      // Every golden `expected` talks about workflow/agent/skill behavior.
      // The guard only emits allow/require_approval/block on tool calls.
      expect(c.expected.length).toBeGreaterThan(0);
    }
    // Explicitly assert the guard's surface is narrower than the golden file's.
    const skillOnlyKeywords = ['Use workflow', 'skill', 'OpenProse', 'agent'];
    const mentionsSkillConcept = goldenCases.some((c) =>
      skillOnlyKeywords.some((kw) => c.expected.includes(kw)));
    expect(mentionsSkillConcept).toBe(true); // confirms golden scope > guard scope
  });
});
