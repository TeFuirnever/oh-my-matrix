import { handleSessionEnd, handleSessionStart } from "./omm-hooks.js";
import { runOmmCancel } from "./omm-tools/omm-cancel.js";
import { runOmmPing } from "./omm-tools/omm-ping.js";

interface OmmPluginApi {
  registerTool?: (
    tool: {
      name: string;
      label?: string;
      description?: string;
      parameters?: Record<string, unknown>;
      execute: (params: Record<string, unknown>) => Promise<unknown>;
    },
    options?: { optional?: boolean; name?: string },
  ) => void;
  on?: (eventName: string, handler: (...args: unknown[]) => unknown) => void;
  config?: Record<string, unknown>;
}

export const id = "omm";
export const name = "omm";
export const version = "0.1.0";

export function register(api: OmmPluginApi): void {
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
          stateRoot: api.config?.stateRoot as string | undefined,
        }),
    },
    { optional: true, name: "omm_cancel" },
  );

  if (typeof api.on === "function") {
    const stateRoot = api.config?.stateRoot as string | undefined;
    api.on("session_start", (args) =>
      handleSessionStart(args as Record<string, unknown>, { stateRoot }),
    );
    api.on("session_end", (args) =>
      handleSessionEnd(args as Record<string, unknown>, { stateRoot }),
    );
  }
}

export default {
  id,
  name,
  version,
  register,
};
