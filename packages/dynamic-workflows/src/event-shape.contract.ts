/**
 * Compile-time contract pinning the OpenClaw `before_tool_call` event shape.
 *
 * If openclaw ever changes `PluginHookBeforeToolCallEvent` (renames `params`,
 * adds a required field, drops `toolName`), THIS FILE FAILS TO BUILD — surfacing
 * the break at compile time instead of as a silent fail-open at runtime.
 *
 * That silent fail-open was the root cause of the 2026-06-28 placebo bug: the
 * guard read `event.args` / `event.toolKind` / `event.cwd`, none of which the
 * openclaw 2026.5.28 host emitted, and tests invented a fictional shape the host
 * never sent. Captured shape (2026-06-28, openclaw 2026.5.28): top-level keys
 * `toolName` / `params` / `runId` / `toolCallId` — no `args` or `cwd`. NOTE:
 * openclaw 2026.7.1 added optional `toolKind` / `toolInputKind` / `derivedPaths`
 * (host-authoritative discriminators) the host may now populate; this guard does
 * not read them yet.
 */
import type { PluginHookBeforeToolCallEvent } from 'openclaw/dist/plugin-sdk/plugin-runtime';

export const REAL_EVENT_SHAPE: PluginHookBeforeToolCallEvent = {
  toolName: 'exec',
  params: { command: 'git reset --hard HEAD~1', workdir: '/ws' },
  runId: 'contract-run',
  toolCallId: 'contract-call',
};
