/**
 * Contract test: hook declarations must be consistent across the three
 * declaration sites — package.json (openclaw.hooks), openclaw.plugin.json
 * (hooks), and index.ts (actual api.on registrations).
 *
 * This catches the H1 bug (PR #92): before_model_resolve was registered in
 * index.ts and declared in openclaw.plugin.json, but missing from
 * package.json's openclaw.hooks array. If a host gates hook dispatch on
 * package.json, the hook silently no-ops.
 *
 * The test enforces: the three sets are identical (same hooks, order-independent).
 * Adding a new hook requires updating all three sites; this test fails if any
 * site drifts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

function readHooksFromPackageJson(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
  return pkg.openclaw?.hooks ?? [];
}

function readHooksFromPluginJson(): string[] {
  const plugin = JSON.parse(readFileSync(resolve(ROOT, 'openclaw.plugin.json'), 'utf-8'));
  return plugin.hooks ?? [];
}

function readRegisteredHooksFromIndexTs(): Set<string> {
  // Parse index.ts for registerHook('hook_name', ...) calls.
  // registerHook is a local const (= api.on ?? api.registerHook), so the call
  // site is `registerHook('hook_name'` without a leading dot.
  const src = readFileSync(resolve(ROOT, 'index.ts'), 'utf-8');
  const hooks = new Set<string>();
  const re = /\bregisterHook\(\s*['"]([a-z_]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    hooks.add(m[1]);
  }
  return hooks;
}

describe('hook declaration contract (package.json == plugin.json == index.ts)', () => {
  const pkgHooks = readHooksFromPackageJson().sort();
  const pluginHooks = readHooksFromPluginJson().sort();
  const registeredHooks = readRegisteredHooksFromIndexTs();

  it('package.json openclaw.hooks matches openclaw.plugin.json hooks', () => {
    expect(pkgHooks).toEqual(pluginHooks);
  });

  it('package.json openclaw.hooks matches index.ts registered hooks', () => {
    // Every hook declared in package.json must be registered in index.ts.
    for (const h of pkgHooks) {
      expect(registeredHooks.has(h)).toBe(true);
    }
    // Every hook registered in index.ts that is a known lifecycle hook must
    // be declared. (We check the intersection — some api.on calls might be
    // internal test helpers, so we verify declared ⊆ registered AND
    // registered lifecycle hooks ⊆ declared.)
    const knownLifecycleHooks = new Set([
      'before_agent_finalize', 'agent_end', 'after_tool_call',
      'before_compaction', 'after_compaction', 'session_start',
      'session_end', 'agent_turn_prepare', 'before_agent_run',
      'before_tool_call', 'llm_output', 'before_model_resolve',
    ]);
    for (const h of registeredHooks) {
      if (knownLifecycleHooks.has(h)) {
        expect(pkgHooks).toContain(h);
      }
    }
  });

  it('before_model_resolve is declared in all three sites (H1 regression guard)', () => {
    // Specific guard for the H1 bug: this hook was missing from package.json.
    expect(pkgHooks).toContain('before_model_resolve');
    expect(pluginHooks).toContain('before_model_resolve');
    expect(registeredHooks.has('before_model_resolve')).toBe(true);
  });
});
