import { handleSessionEnd, handleSessionStart } from "./omm-hooks.js";
import { runOmmCancel } from "./omm-tools/omm-cancel.js";
import { runOmmPing } from "./omm-tools/omm-ping.js";
import { runOmmStateList, runOmmStateRead, runOmmStateWrite, } from "./omm-tools/omm-state.js";
export const id = "omm";
export const name = "omm";
export const version = "0.2.1";
/** OpenClaw plugin entry point — registers omm tools and lifecycle hooks. */
export function register(api) {
    if (typeof api.registerTool !== "function") {
        return;
    }
    api.registerTool({
        name: "omm_ping",
        label: "omm ping",
        description: "Write an omm smoke-test state record and return a pong response.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                command: { type: "string" },
                commandName: { type: "string" },
                skillName: { type: "string" },
            },
        },
        execute: (params) => runOmmPing(params, { stateRoot: api.config?.stateRoot }),
    }, { optional: true, name: "omm_ping" });
    api.registerTool({
        name: "omm_cancel",
        label: "omm cancel",
        description: "Cancel the current omm session and write a cancel record.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                sessionId: { type: "string" },
            },
        },
        execute: (params) => runOmmCancel(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_cancel" });
    api.registerTool({
        name: "omm_state_write",
        label: "omm state write",
        description: "Write a validated JSON state object by key. Validates ralph/autopilot/team schemas.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                key: { type: "string" },
                value: { type: "object" },
            },
            required: ["key", "value"],
        },
        execute: (params) => runOmmStateWrite(params, {
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
        execute: (params) => runOmmStateRead(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_state_read" });
    api.registerTool({
        name: "omm_state_list",
        label: "omm state list",
        description: "List all state keys.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        execute: (params) => runOmmStateList(params, {
            stateRoot: api.config?.stateRoot,
        }),
    }, { optional: true, name: "omm_state_list" });
    if (typeof api.on === "function") {
        const stateRoot = api.config?.stateRoot;
        api.on("session_start", (args) => handleSessionStart(args, { stateRoot }));
        api.on("session_end", (args) => handleSessionEnd(args, { stateRoot }));
    }
}
export default {
    id,
    name,
    version,
    register,
};
//# sourceMappingURL=omm-register.js.map