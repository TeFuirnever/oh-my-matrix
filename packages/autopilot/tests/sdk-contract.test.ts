/**
 * SDK Contract Tests for autopilot plugin
 *
 * These tests verify that every hook name registered by the autopilot plugin
 * exists in the SDK's canonical PLUGIN_HOOK_NAMES list. This prevents
 * silent failures where a misspelled or phantom hook name is registered but
 * never fires (e.g. the historical bug where `before_agent_run` was used
 * instead of the correct `before_agent_start`).
 */
import { describe, it, expect } from 'vitest';
// PLUGIN_HOOK_NAMES and OpenClawPluginApi are both exported from plugin-runtime.
import { PLUGIN_HOOK_NAMES } from 'openclaw/plugin-sdk/plugin-runtime';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

// ---------------------------------------------------------------------------
// Part 1: Hook name contract
//
// Keep this list in sync with the hooks registered in
// the host's plugin source tree (autopilot/index.ts).
// ---------------------------------------------------------------------------

/**
 * All hook names that autopilot/index.ts registers.
 * All entries must exist in PLUGIN_HOOK_NAMES or the test fails.
 */
const AUTOPILOT_REGISTERED_HOOKS = [
  'before_agent_finalize',
  'after_tool_call',
  'before_compaction',
  'after_compaction',
  'agent_turn_prepare',
  'before_agent_run',
  'before_tool_call',
  'llm_output',
  'session_start',
  'session_end',
  'agent_end',
] as const;

describe('autopilot SDK contract — hook names', () => {
  it('every registered hook name must exist in PLUGIN_HOOK_NAMES', () => {
    const sdkSet = new Set<string>(PLUGIN_HOOK_NAMES);
    const phantomHooks = AUTOPILOT_REGISTERED_HOOKS.filter((h) => !sdkSet.has(h));

    expect(phantomHooks, `Found hook name(s) not in SDK: ${phantomHooks.join(', ')}`).toHaveLength(0);
  });

  it('PLUGIN_HOOK_NAMES contains before_agent_run (gate hook for agent exclusion)', () => {
    expect(PLUGIN_HOOK_NAMES).toContain('before_agent_run');
  });
});

// ---------------------------------------------------------------------------
// Part 2: OpenClawPluginApi method existence (compile-time type checks)
//
// If the SDK removes or renames one of these methods, TypeScript will fail
// at build time — providing an early warning before the plugin is deployed.
// ---------------------------------------------------------------------------

describe('autopilot SDK contract — OpenClawPluginApi methods', () => {
  it('OpenClawPluginApi has registerGatewayMethod', () => {
    type HasIt = OpenClawPluginApi extends { registerGatewayMethod: unknown } ? true : false;
    const check: HasIt = true;
    expect(check).toBe(true);
  });

  it('OpenClawPluginApi has session.workflow.enqueueNextTurnInjection (grouped facade, 5.28+)', () => {
    type HasWorkflow = OpenClawPluginApi extends { session: { workflow: { enqueueNextTurnInjection: unknown } } } ? true : false;
    const check: HasWorkflow = true;
    expect(check).toBe(true);
  });

  it('OpenClawPluginApi has session.state.registerSessionExtension (grouped facade, 5.28+)', () => {
    type HasState = OpenClawPluginApi extends { session: { state: { registerSessionExtension: unknown } } } ? true : false;
    const check: HasState = true;
    expect(check).toBe(true);
  });

  it('OpenClawPluginApi has registerSessionAction (added in 2026.5.28)', () => {
    type HasIt = OpenClawPluginApi extends { registerSessionAction: unknown } ? true : false;
    const check: HasIt = true;
    expect(check).toBe(true);
  });
});
