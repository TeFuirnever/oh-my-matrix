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
export declare function dispatchOmmHooks(event: OmmHookEvent, args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<OmmHookDispatchResult | null>;
type HookHandler = (args: Record<string, unknown>, config?: {
    stateRoot?: string;
}) => Promise<void>;
export declare const handleBeforeToolCall: HookHandler;
export declare const handleAfterToolCall: HookHandler;
export declare const handleLlmInput: HookHandler;
export declare const handleLlmOutput: HookHandler;
export declare const handleAgentEnd: HookHandler;
export declare const handleSubagentSpawning: HookHandler;
export declare const handleSubagentSpawned: HookHandler;
export declare const handleSubagentEnded: HookHandler;
export declare const handleGatewayStart: HookHandler;
export declare const handleGatewayStop: HookHandler;
/** Write session_start record + dispatch user hooks. */
export declare function handleSessionStart(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
/** Write session_end record + dispatch user hooks. Errors silenced. */
export declare function handleSessionEnd(args: Record<string, unknown>, config?: {
    stateRoot?: string;
}): Promise<void>;
export {};
