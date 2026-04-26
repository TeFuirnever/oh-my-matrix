import { handleSessionEnd, handleSessionStart } from "./omm-hooks.js";
import { runOmmCancel } from "./omm-tools/omm-cancel.js";
import { runOmmPing } from "./omm-tools/omm-ping.js";
import {
  runOmmStateList,
  runOmmStateRead,
  runOmmStateWrite,
} from "./omm-tools/omm-state.js";

interface OmmPluginApi {
  registerTool?: (
    tool: {
      name: string;
      label?: string;
      description?: string;
      parameters?: Record<string, unknown>;
      // OpenClaw runtime invokes execute as (toolCallId, params, signal, onUpdate).
      // The toolCallId is a string (e.g. "toolu_abc123"); params holds the
      // schema-validated argument object the LLM produced. Capturing only the
      // first arg (the id) — as a 1-arg signature would — silently treats the
      // id as the params object and breaks every field access.
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: (delta: string) => void,
      ) => Promise<unknown>;
    },
    options?: { optional?: boolean; name?: string },
  ) => void;
  on?: (eventName: string, handler: (...args: unknown[]) => unknown) => void;
  config?: Record<string, unknown>;
}

export const id = "omm";
export const name = "omm";
export const version = "0.2.2";

/** OpenClaw plugin entry point — registers omm tools and lifecycle hooks. */
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
      execute: (_toolCallId, params) =>
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
      execute: (_toolCallId, params) =>
        runOmmCancel(params, {
          stateRoot: api.config?.stateRoot as string | undefined,
        }),
    },
    { optional: true, name: "omm_cancel" },
  );

  api.registerTool(
    {
      name: "omm_state_write",
      label: "omm state write",
      description:
        "Write a validated JSON state object by key. Validates ralph/autopilot/team schemas.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          value: { type: "object" },
        },
        required: ["key", "value"],
      },
      execute: (_toolCallId, params) =>
        runOmmStateWrite(params, {
          stateRoot: api.config?.stateRoot as string | undefined,
        }),
    },
    { optional: true, name: "omm_state_write" },
  );

  api.registerTool(
    {
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
      execute: (_toolCallId, params) =>
        runOmmStateRead(params, {
          stateRoot: api.config?.stateRoot as string | undefined,
        }),
    },
    { optional: true, name: "omm_state_read" },
  );

  api.registerTool(
    {
      name: "omm_state_list",
      label: "omm state list",
      description: "List all state keys.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: (_toolCallId, params) =>
        runOmmStateList(params, {
          stateRoot: api.config?.stateRoot as string | undefined,
        }),
    },
    { optional: true, name: "omm_state_list" },
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
