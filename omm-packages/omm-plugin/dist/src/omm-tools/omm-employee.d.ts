import type { OmmToolResult } from "./omm-tool-result.js";
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
/**
 * Poll for multiple dispatch results concurrently (fork-join collection).
 *
 * omm_employee_result is a blocking poll loop (up to 60s per runId), and LLM
 * tool calls execute sequentially within a turn — so the LLM cannot itself
 * poll N runIds in parallel. This batch tool runs Promise.all over the
 * individual polls so all results arrive in one tool call, enabling true
 * fork-join semantics for multi-agent team execution.
 */
export interface OmmEmployeeResultBatchInput {
    runIds?: unknown;
}
/** Poll for multiple dispatch results concurrently. Returns all results at once. */
export declare function runOmmEmployeeResultBatch(input: OmmEmployeeResultBatchInput, config?: OmmEmployeeConfig): Promise<OmmToolResult>;
