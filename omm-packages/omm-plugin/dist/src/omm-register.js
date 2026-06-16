import { handleAfterCompaction, handleAfterToolCall, handleAgentEnd, handleBeforeCompaction, handleBeforeToolCall, handleGatewayStart, handleGatewayStop, handleLlmInput, handleLlmOutput, handleSessionEnd, handleSessionStart, handleSubagentEnded, handleSubagentSpawned, handleSubagentSpawning, } from "./omm-hooks.js";
import { runOmmEmployeeDispatch, runOmmEmployeeList, runOmmEmployeeResult, runOmmEmployeeResultBatch, } from "./omm-tools/omm-employee.js";
import { runOmmStateRead, runOmmStateWrite } from "./omm-tools/omm-state.js";
/**
 * Plugin/MCP API contract version. Hosts that depend on a specific shape
 * for tool results, error envelopes, or state semantics should compare
 * against this constant rather than parsing `package.json` version strings.
 *
 * Bump on breaking surface changes (tool signatures, error envelope, state
 * file layout). Patch and minor releases keep `API_VERSION` stable.
 *
 * @see docs/contracts/error-codes.md
 * @since 0.3.0
 */
export const OMM_API_VERSION = "0.3";
export const id = "omm";
export const name = "omm";
export const version = "0.5.0";
/** OpenClaw plugin entry point — registers omm tools and lifecycle hooks. */
export function register(api) {
    if (typeof api.registerTool !== "function") {
        return;
    }
    api.registerTool({
        name: "omm_state_write",
        label: "omm state write",
        description: "Write a validated JSON state object by key. Validates the team workflow schema.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                key: { type: "string" },
                value: { type: "object" },
            },
            required: ["key", "value"],
        },
        execute: (_toolCallId, params) => runOmmStateWrite(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_state_write" });
    api.registerTool({
        name: "omm_state_read",
        label: "omm state read",
        description: "Read a JSON state file by key. Returns null if not found.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                key: { type: "string" },
            },
            required: ["key"],
        },
        execute: (_toolCallId, params) => runOmmStateRead(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_state_read" });
    api.registerTool({
        name: "omm_employee_list",
        label: "omm employee list",
        description: "List active MatrixAssistant digital employees from the cached registry. Returns { employees: [] } when no host cache exists (host is not MA, or no employee activated).",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        execute: (_toolCallId, params) => runOmmEmployeeList(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_employee_list" });
    api.registerTool({
        name: "omm_employee_dispatch",
        label: "omm employee dispatch",
        description: "Dispatch a subtask to an MA digital employee via the state-file relay. Returns { runId, status: 'dispatched' }. Poll with omm_employee_result. MA watches the dispatch dir and fulfills via chat.send.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                agentId: { type: "string" },
                message: { type: "string" },
            },
            required: ["agentId", "message"],
        },
        execute: (_toolCallId, params) => runOmmEmployeeDispatch(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_employee_dispatch" });
    api.registerTool({
        name: "omm_employee_result",
        label: "omm employee result",
        description: "Poll for a dispatch result by runId (up to 60s). Returns { runId, status: 'complete', output } or a DISPATCH_TIMEOUT error.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                runId: { type: "string" },
            },
            required: ["runId"],
        },
        execute: (_toolCallId, params) => runOmmEmployeeResult(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_employee_result" });
    api.registerTool({
        name: "omm_employee_result_batch",
        label: "omm employee result batch",
        description: "Poll for multiple dispatch results concurrently (fork-join collection). Returns all results in one call. Required because omm_employee_result blocks for up to 60s per runId and LLM tool calls execute sequentially.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                runIds: {
                    type: "array",
                    items: { type: "string" },
                    maxItems: 10,
                },
            },
            required: ["runIds"],
        },
        execute: (_toolCallId, params) => runOmmEmployeeResultBatch(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_employee_result_batch" });
    if (typeof api.on === "function") {
        const stateRoot = api.config?.stateRoot;
        // OpenClaw invokes hooks as handler(event, ctx). ctx carries sessionId,
        // runId, sessionKey etc that the event payload alone may omit. Merging
        // both into a flat args object so handlers see all fields.
        const merge = (event, ctx) => ({
            ...event,
            ...ctx,
        });
        api.on("session_start", (ev, ctx) => handleSessionStart(merge(ev, ctx), { stateRoot }));
        api.on("session_end", (ev, ctx) => handleSessionEnd(merge(ev, ctx), { stateRoot }));
        api.on("before_tool_call", (ev, ctx) => handleBeforeToolCall(merge(ev, ctx), { stateRoot }));
        api.on("after_tool_call", (ev, ctx) => handleAfterToolCall(merge(ev, ctx), { stateRoot }));
        api.on("llm_input", (ev, ctx) => handleLlmInput(merge(ev, ctx), { stateRoot }));
        api.on("llm_output", (ev, ctx) => handleLlmOutput(merge(ev, ctx), { stateRoot }));
        api.on("agent_end", (ev, ctx) => handleAgentEnd(merge(ev, ctx), { stateRoot }));
        api.on("subagent_spawning", (ev, ctx) => handleSubagentSpawning(merge(ev, ctx), { stateRoot }));
        api.on("subagent_spawned", (ev, ctx) => handleSubagentSpawned(merge(ev, ctx), { stateRoot }));
        api.on("subagent_ended", (ev, ctx) => handleSubagentEnded(merge(ev, ctx), { stateRoot }));
        api.on("gateway_start", (ev, ctx) => handleGatewayStart(merge(ev, ctx), { stateRoot }));
        api.on("gateway_stop", (ev, ctx) => handleGatewayStop(merge(ev, ctx), { stateRoot }));
        api.on("before_compaction", (ev, ctx) => handleBeforeCompaction(merge(ev, ctx), { stateRoot }));
        api.on("after_compaction", (ev, ctx) => handleAfterCompaction(merge(ev, ctx), { stateRoot }));
    }
    else {
        // F3: silent host = invisible debugging. One-time stderr line tells the
        // operator "hooks are loadable but no events will fire". Cheap signal,
        // does not affect tool execution.
        process.stderr.write("[omm-register] host did not provide api.on(); hook events will not fire " +
            "(install hooks under {stateRoot}/hooks/{event}/ once the host wires lifecycle events)\n");
    }
}
export default {
    id,
    name,
    version,
    register,
};
//# sourceMappingURL=omm-register.js.map