import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";
import {
  dispatchHooks,
  type HookDispatchOutcome,
  type HookLoadIssue,
} from "./omm-hook-loader.js";

/**
 * omm event names matching OpenClaw Plugin Hook API (hook-types.ts).
 * These are the subset of OpenClaw's 26 hook types that omm handles.
 * User-supplied hook modules in `{stateRoot}/hooks/{event}/` are loaded
 * and dispatched on every event.
 *
 * @since 0.3.0
 */
export type OmmHookEvent =
  | "session_start"
  | "session_end"
  | "before_tool_call"
  | "after_tool_call"
  | "llm_input"
  | "llm_output"
  | "agent_end"
  | "subagent_spawning"
  | "subagent_spawned"
  | "subagent_ended"
  | "gateway_start"
  | "gateway_stop";

export interface OmmSessionRecord {
  event: "session_start" | "session_end";
  timestamp: string;
  sessionId?: string;
}

export interface OmmHookDispatchResult {
  outcomes: HookDispatchOutcome[];
  issues: HookLoadIssue[];
}

const HOOKS_DIR_NAME = "hooks";

async function writeSessionRecord(
  event: OmmSessionRecord["event"],
  args: Record<string, unknown>,
  config?: { stateRoot?: string },
): Promise<void> {
  const stateRoot = resolveOmmStateRoot(config?.stateRoot);
  const stateDir = join(stateRoot, "state");
  await mkdir(stateDir, { recursive: true });

  const record: OmmSessionRecord = {
    event,
    timestamp: new Date().toISOString(),
  };
  if (typeof args.sessionId === "string" && args.sessionId !== "") {
    record.sessionId = args.sessionId;
  }

  await writeFile(
    join(stateDir, "session.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export async function dispatchOmmHooks(
  event: OmmHookEvent,
  args: Record<string, unknown>,
  config?: { stateRoot?: string },
): Promise<OmmHookDispatchResult | null> {
  try {
    const stateRoot = resolveOmmStateRoot(config?.stateRoot);
    const hooksDir = join(stateRoot, HOOKS_DIR_NAME, event);
    return await dispatchHooks(hooksDir, event, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[omm-hooks] dispatchOmmHooks(${event}) failed: ${message}\n`,
    );
    return null;
  }
}

async function appendTraceEvent(
  sessionId: string,
  event: Record<string, unknown>,
  config?: { stateRoot?: string },
): Promise<void> {
  const stateRoot = resolveOmmStateRoot(config?.stateRoot);
  const traceDirectory = join(stateRoot, "trace");
  try {
    await mkdir(traceDirectory, { recursive: true });
    const safeId = sessionId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "_";
    await appendFile(
      join(traceDirectory, `${safeId}.jsonl`),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  } catch {
    // Trace writing is best-effort; never crash the host event path.
  }
}

function extractString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const val = obj[key];
  return typeof val === "string" && val !== "" ? val : undefined;
}

// ── Trace spec: describes how to build a trace record from hook args ──

type TraceSpec = {
  type: string;
  build: (args: Record<string, unknown>) => Record<string, unknown>;
};

const TRACE_SPECS: Partial<Record<OmmHookEvent, TraceSpec>> = {
  before_tool_call: {
    type: "before_tool_call",
    build: (a) => ({
      toolName: a.toolName ?? a.tool_name,
      toolCallId: a.toolCallId ?? a.tool_call_id,
      runId: a.runId ?? a.run_id,
    }),
  },
  after_tool_call: {
    type: "after_tool_call",
    build: (a) => ({
      toolName: a.toolName ?? a.tool_name,
      toolCallId: a.toolCallId ?? a.tool_call_id,
      runId: a.runId ?? a.run_id,
      durationMs: a.durationMs ?? a.duration_ms,
      ok: a.error == null,
      error: typeof a.error === "string" ? a.error : undefined,
    }),
  },
  llm_input: {
    type: "llm_input",
    build: (a) => ({
      provider: a.provider,
      model: a.model,
      runId: a.runId ?? a.run_id,
    }),
  },
  llm_output: {
    type: "llm_output",
    build: (a) => ({
      provider: a.provider,
      model: a.model,
      runId: a.runId ?? a.run_id,
      usage: a.usage,
    }),
  },
  agent_end: {
    type: "agent_end",
    build: (a) => ({
      success: a.success,
      durationMs: a.durationMs ?? a.duration_ms,
    }),
  },
};

// ── Handler factory ──

type HookHandler = (
  args: Record<string, unknown>,
  config?: { stateRoot?: string },
) => Promise<void>;

function makeTraceHandler(event: OmmHookEvent, spec: TraceSpec): HookHandler {
  return async (args, config) => {
    const sessionId = extractString(args, "sessionId");
    if (sessionId) {
      await appendTraceEvent(
        sessionId,
        {
          timestamp: new Date().toISOString(),
          type: spec.type,
          ...spec.build(args),
        },
        config,
      );
    }
    await dispatchOmmHooks(event, args, config);
  };
}

function makeDispatchOnlyHandler(event: OmmHookEvent): HookHandler {
  return async (args, config) => {
    await dispatchOmmHooks(event, args, config);
  };
}

// ── Generated handlers ──

export const handleBeforeToolCall = makeTraceHandler(
  "before_tool_call",
  TRACE_SPECS.before_tool_call!,
);
export const handleAfterToolCall = makeTraceHandler(
  "after_tool_call",
  TRACE_SPECS.after_tool_call!,
);
export const handleLlmInput = makeTraceHandler(
  "llm_input",
  TRACE_SPECS.llm_input!,
);
export const handleLlmOutput = makeTraceHandler(
  "llm_output",
  TRACE_SPECS.llm_output!,
);
export const handleAgentEnd = makeTraceHandler(
  "agent_end",
  TRACE_SPECS.agent_end!,
);
export const handleSubagentSpawning =
  makeDispatchOnlyHandler("subagent_spawning");
export const handleSubagentSpawned =
  makeDispatchOnlyHandler("subagent_spawned");
export const handleSubagentEnded = makeDispatchOnlyHandler("subagent_ended");
export const handleGatewayStart = makeDispatchOnlyHandler("gateway_start");
export const handleGatewayStop = makeDispatchOnlyHandler("gateway_stop");

// ── Session handlers (custom logic for session record file) ──

/** Write session_start record + dispatch user hooks. */
export async function handleSessionStart(
  args: Record<string, unknown>,
  config?: { stateRoot?: string },
): Promise<void> {
  await writeSessionRecord("session_start", args, config);
  await dispatchOmmHooks("session_start", args, config);
}

/** Write session_end record + dispatch user hooks. Errors silenced. */
export async function handleSessionEnd(
  args: Record<string, unknown>,
  config?: { stateRoot?: string },
): Promise<void> {
  try {
    await writeSessionRecord("session_end", args, config);
  } catch {
    // State dir may not exist if session_start never fired
  }
  await dispatchOmmHooks("session_end", args, config);
}
