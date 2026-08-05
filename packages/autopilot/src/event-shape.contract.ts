/**
 * Compile-time contract pinning the OpenClaw `before_tool_call` event shape that
 * autopilot's permission hook (index.ts `before_tool_call`) reads.
 *
 * If openclaw ever changes `PluginHookBeforeToolCallEvent` (renames `params`,
 * drops `toolName`, moves the shell command off `params.command`), THIS FILE
 * FAILS TO BUILD — surfacing the break at compile time instead of as a silent
 * fail-open at runtime (the hook would read `undefined` and degrade to
 * classifying by `toolName` alone, letting shell commands through unchecked).
 *
 * Mirrors dynamic-workflows/src/event-shape.contract.ts. Captured shape
 * (2026-06-28, openclaw 2026.5.28): top-level keys `toolName` / `params` /
 * `runId` / `toolCallId` — no `args` or `cwd`. NOTE: openclaw 2026.7.1 added
 * optional `toolKind` / `toolInputKind` / `derivedPaths` (host-authoritative
 * discriminators) the host may now populate; this hook does not read them yet.
 * Command lives in `params.command` (shell string); cwd in `params.workdir`.
 *
 * Not re-exported from the package barrel: this is a build-time assertion, not
 * part of autopilot's public API.
 */
import type { PluginHookBeforeToolCallEvent } from 'openclaw/dist/plugin-sdk/plugin-runtime';

export const REAL_BEFORE_TOOL_CALL_SHAPE: PluginHookBeforeToolCallEvent = {
  toolName: 'exec',
  params: { command: 'git reset --hard HEAD~1', workdir: '/ws' },
  runId: 'contract-run',
  toolCallId: 'contract-call',
};
