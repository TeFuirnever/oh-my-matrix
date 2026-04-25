import type { OmmToolResult } from "./omm-ping.js";
export interface OmmCancelInput {
  sessionId?: unknown;
}
export interface OmmCancelConfig {
  stateRoot?: string;
}
export declare function runOmmCancel(
  input: OmmCancelInput,
  config?: OmmCancelConfig,
): Promise<OmmToolResult>;
