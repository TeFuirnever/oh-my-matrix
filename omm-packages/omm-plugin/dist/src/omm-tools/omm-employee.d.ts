import type { OmmToolResult } from "./omm-ping.js";
export interface OmmEmployeeConfig {
    stateRoot?: string;
}
export interface OmmEmployeeDispatchInput {
    agentId?: unknown;
    message?: unknown;
}
export interface OmmEmployeeResultInput {
    runId?: unknown;
}
/** List active MA digital employees from the cached registry file. */
export declare function runOmmEmployeeList(_input: Record<string, unknown>, config?: OmmEmployeeConfig): Promise<OmmToolResult>;
/** Dispatch a subtask to an MA digital employee. Returns a runId to poll. */
export declare function runOmmEmployeeDispatch(input: OmmEmployeeDispatchInput, config?: OmmEmployeeConfig): Promise<OmmToolResult>;
/** Poll for a dispatch result. Returns the employee's output or a timeout. */
export declare function runOmmEmployeeResult(input: OmmEmployeeResultInput, config?: OmmEmployeeConfig): Promise<OmmToolResult>;
