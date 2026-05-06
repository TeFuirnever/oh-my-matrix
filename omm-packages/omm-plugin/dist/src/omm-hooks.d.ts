import { type HookDispatchOutcome, type HookLoadIssue } from "./omm-hook-loader.js";
/**
 * omm event names matching OpenClaw Plugin Hook API (hook-types.ts).
 * These are the subset of OpenClaw's 26 hook types that omm handles.
 * User-supplied hook modules in `{stateRoot}/hooks/{event}/` are loaded
 * and dispatched on every event.
 *
 * @since 0.3.0
 */
export type OmmHookEvent = "session_start" | "session_end" | "before_tool_call" | "after_tool_call" | "llm_input" | "llm_output" | "agent_end" | "subagent_spawning" | "subagent_spawned" | "subagent_ended" | "gateway_start" | "gateway_stop";
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
/** Dispatch user-installed hooks + record before_tool_call trace. */
export declare function handleBeforeToolCall(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed hooks + record after_tool_call trace. */
export declare function handleAfterToolCall(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed llm_input hooks + record trace. */
export declare function handleLlmInput(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed llm_output hooks + record trace. */
export declare function handleLlmOutput(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed agent_end hooks + record trace. */
export declare function handleAgentEnd(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed subagent_spawning hooks. */
export declare function handleSubagentSpawning(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed subagent_spawned hooks. */
export declare function handleSubagentSpawned(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed subagent_ended hooks. */
export declare function handleSubagentEnded(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed gateway_start hooks. */
export declare function handleGatewayStart(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Dispatch user-installed gateway_stop hooks. */
export declare function handleGatewayStop(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
