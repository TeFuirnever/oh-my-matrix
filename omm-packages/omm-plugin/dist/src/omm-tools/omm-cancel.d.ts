import type { OmmToolResult } from "./omm-ping.js";
export interface OmmCancelInput {
    sessionId?: unknown;
}
export interface OmmCancelConfig {
    stateRoot?: string;
}
/** Execute omm_cancel tool — writes a cancellation record for the given session. */
export declare function runOmmCancel(input: OmmCancelInput, config?: OmmCancelConfig): Promise<OmmToolResult>;
