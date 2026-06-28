#!/usr/bin/env node
// Smoke-verify the DEPLOYED dynamic-workflows guard dist (the exact file MA loads).
// Drives real-shape before_tool_call events directly — bypasses the MA UI and the
// main-session agent (which declines to dispatch destructive ops to subagents).
// Run after scripts/sync-to-ma.sh. Exits non-zero if any expected block is missing.
//
// Why this exists: the 2026-06-28 placebo bug shipped because tests used a fictional
// event shape. This require()s MA's ACTUAL loaded dist, so a deploy drift (e.g.
// missing permission-policy lib dist) surfaces here as a crash, not silently at runtime.
const path = require('path');
const MA_DIR = process.env.MA_DIR || path.resolve(__dirname, '../../MatrixAssistant');
const guard = require(`${MA_DIR}/resources/claw-plugin/dynamic-workflows/dist/index.js`);

let captured;
const api = {
  pluginConfig: {},
  on: (_name, handler, opts) => { captured = { handler, opts }; },
};
guard.register(api);

const SUB = 'agent:main:subagent:live-verify-uuid';
const cases = [
  ['destructive (cd && git reset --hard)', { toolName: 'exec', params: { command: 'cd /tmp && git reset --hard HEAD~1' } }, { sessionKey: SUB }, 'block'],
  ['safe (cd && git status)', { toolName: 'exec', params: { command: 'cd /tmp && git status' } }, { sessionKey: SUB }, 'allow'],
  ['main session (no :subagent:)', { toolName: 'exec', params: { command: 'git reset --hard' } }, { sessionKey: 'agent:main:main' }, 'allow'],
  ['rm -rf', { toolName: 'exec', params: { command: 'rm -rf /important' } }, { sessionKey: SUB }, 'block'],
  ['force-push (evasion)', { toolName: 'exec', params: { command: 'cd /tmp && git push --force origin main' } }, { sessionKey: SUB }, 'block'],
  ['shell substitution $(rm)', { toolName: 'exec', params: { command: 'echo $(rm -rf /)' } }, { sessionKey: SUB }, 'block'],
  ['wrapper exec npx rm', { toolName: 'exec', params: { command: 'npx rm -rf dist' } }, { sessionKey: SUB }, 'block'],
];

(async () => {
  let failed = 0;
  console.log('priority:', captured?.opts?.priority, '(expect 11)');
  for (const [label, event, ctx, expect] of cases) {
    const r = await captured.handler(event, ctx);
    const got = r && r.block ? 'block' : 'allow';
    const ok = got === expect;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(34)} → ${got} (expect ${expect})`);
  }
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
