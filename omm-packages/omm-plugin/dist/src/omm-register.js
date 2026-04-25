import { handleSessionEnd, handleSessionStart } from "./omm-hooks.js";
import { runOmmCancel } from "./omm-tools/omm-cancel.js";
import { runOmmPing } from "./omm-tools/omm-ping.js";
export const id = "omm";
export const name = "omm";
export const version = "0.2.0";
/** OpenClaw plugin entry point — registers omm tools and lifecycle hooks. */
export function register(api) {
  if (typeof api.registerTool !== "function") {
    return;
  }
  api.registerTool(
    {
      name: "omm_ping",
      label: "omm ping",
      description:
        "Write an omm smoke-test state record and return a pong response.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          commandName: { type: "string" },
          skillName: { type: "string" },
        },
      },
      execute: (params) =>
        runOmmPing(params, { stateRoot: api.config?.stateRoot }),
    },
    { optional: true, name: "omm_ping" },
  );
  api.registerTool(
    {
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
      execute: (params) =>
        runOmmCancel(params, {
          stateRoot: api.config?.stateRoot,
        }),
    },
    { optional: true, name: "omm_cancel" },
  );
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
