/**
 * Compile-time contract pinning the OpenClaw `before_tool_call` event shape.
 *
 * If openclaw ever changes `PluginHookBeforeToolCallEvent` (renames `params`,
 * adds a required field, drops `toolName`), THIS FILE FAILS TO BUILD — surfacing
 * the break at compile time instead of as a silent fail-open at runtime.
 *
 * That silent fail-open was the root cause of the 2026-06-28 placebo bug: the
 * guard read `event.args` / `event.toolKind` / `event.cwd`, none of which exist
 * on the real event, and tests invented a fictional shape the host never emits.
 * Verified live shape (2026-06-28 capture): top-level keys are exactly
 * `toolName` / `params` / `runId` / `toolCallId` — NO `args`, `toolKind`, or `cwd`.
 */
import type { PluginHookBeforeToolCallEvent } from 'openclaw/dist/plugin-sdk/plugin-runtime';
export declare const REAL_EVENT_SHAPE: PluginHookBeforeToolCallEvent;
//# sourceMappingURL=event-shape.contract.d.ts.map