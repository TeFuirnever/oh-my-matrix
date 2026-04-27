import { type HookDispatchOutcome, type HookLoadIssue } from "./omm-hook-loader.js";
/**
 * omm event names emitted to plugin hooks. Hosts (OpenClaw, MatrixAssistant)
 * inject these by calling `api.on(event, handler)`; omm-register.ts wires the
 * handlers below so user-supplied hook modules in `{stateRoot}/hooks/{event}/`
 * are loaded and dispatched on every event.
 *
 * @since 0.3.0
 */
export type OmmHookEvent = "session_start" | "session_end" | "pre_tool_use" | "post_tool_use" | "mode_change";
export interface OmmSessionRecord {
    event: "session_start" | "session_end";
    timestamp: string;
    sessionId?: string;
}
export interface OmmHookDispatchResult {
    outcomes: HookDispatchOutcome[];
    issues: HookLoadIssue[];
}
/**
 * Load and dispatch user-installed hooks for `event`.
 *
 * Hook modules live in `{stateRoot}/hooks/{event}/*.mjs`. Each module
 * must export `{ event, handler }` where `event` matches the directory name
 * and `handler(args)` is the callback. See docs/contracts/hooks.md.
 *
 * Errors during load or dispatch are surfaced via the returned outcome but
 * never thrown — host event emission must not crash because a user hook is
 * broken.
 */
export declare function dispatchOmmHooks(event: OmmHookEvent, args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<OmmHookDispatchResult | null>;
/** Write session_start record + dispatch user hooks. */
export declare function handleSessionStart(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Write session_end record + dispatch user hooks. Errors silenced. */
export declare function handleSessionEnd(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed pre_tool_use hooks. */
export declare function handlePreToolUse(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed post_tool_use hooks. */
export declare function handlePostToolUse(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed mode_change hooks. */
export declare function handleModeChange(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
