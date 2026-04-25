import { runOmmCancel } from "./omm-tools/omm-cancel.js";
import { runOmmPing } from "./omm-tools/omm-ping.js";
export const id = "omm";
export const name = "omm";
export const version = "0.1.0";
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
}
export default {
  id,
  name,
  version,
  register,
};
//# sourceMappingURL=omm-register.js.map
