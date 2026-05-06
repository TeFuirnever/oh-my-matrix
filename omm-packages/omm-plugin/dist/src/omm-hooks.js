import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";
import { dispatchHooks, } from "./omm-hook-loader.js";
const HOOKS_DIR_NAME = "hooks";
async function writeSessionRecord(event, args, config) {
    const stateRoot = resolveOmmStateRoot(config?.stateRoot);
    const stateDir = join(stateRoot, "state");
    await mkdir(stateDir, { recursive: true });
    const record = {
        event,
        timestamp: new Date().toISOString(),
    };
    // F2: populate sessionId when host emits it; otherwise leave the field
    // off the JSON output so absent doesn't masquerade as null.
    if (typeof args.sessionId === "string" && args.sessionId !== "") {
        record.sessionId = args.sessionId;
    }
    await writeFile(join(stateDir, "session.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
/**
 * Load and dispatch user-installed hooks for `event`.
 *
 * Hook modules live in `{stateRoot}/hooks/{event}/*.mjs`. Each module
 * must export `{ event, handler }` where `event` matches the directory name
 * and `handler(args)` is the callback. See docs/contracts/hooks.md.
 *
 * Errors during load or dispatch are surfaced via the returned outcome but
 * never thrown — host event emission must not crash because a user hook is
 * broken.
 */
export async function dispatchOmmHooks(event, args, config) {
    try {
        const stateRoot = resolveOmmStateRoot(config?.stateRoot);
        const hooksDir = join(stateRoot, HOOKS_DIR_NAME, event);
        return await dispatchHooks(hooksDir, event, args);
    }
    catch (err) {
        // F1: infrastructure failure (config root unresolvable). Log to stderr
        // so operators see a signal even though we still return null to keep
        // the host event path crash-free.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[omm-hooks] dispatchOmmHooks(${event}) failed: ${message}\n`);
        return null;
    }
}
/** Write session_start record + dispatch user hooks. */
export async function handleSessionStart(args, config) {
    await writeSessionRecord("session_start", args, config);
    await dispatchOmmHooks("session_start", args, config);
}
/** Write session_end record + dispatch user hooks. Errors silenced. */
export async function handleSessionEnd(args, config) {
    try {
        await writeSessionRecord("session_end", args, config);
    }
    catch {
        // State dir may not exist if session_start never fired
    }
    await dispatchOmmHooks("session_end", args, config);
}
/** Record a trace event to the append-only JSONL log. */
async function appendTraceEvent(sessionId, event, config) {
    const stateRoot = resolveOmmStateRoot(config?.stateRoot);
    const traceDirectory = join(stateRoot, "trace");
    try {
        await mkdir(traceDirectory, { recursive: true });
        const safeId = sessionId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "_";
        await appendFile(join(traceDirectory, `${safeId}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
    }
    catch {
        // Trace writing is best-effort; never crash the host event path.
    }
}
/** Dispatch user-installed hooks + record before_tool_call trace. */
export async function handleBeforeToolCall(args, config) {
    const sessionId = extractString(args, "sessionId");
    if (sessionId) {
        await appendTraceEvent(sessionId, {
            timestamp: new Date().toISOString(),
            type: "before_tool_call",
            toolName: args.toolName ?? args.tool_name,
            toolCallId: args.toolCallId ?? args.tool_call_id,
            runId: args.runId ?? args.run_id,
        }, config);
    }
    await dispatchOmmHooks("before_tool_call", args, config);
}
/** Dispatch user-installed hooks + record after_tool_call trace. */
export async function handleAfterToolCall(args, config) {
    const sessionId = extractString(args, "sessionId");
    if (sessionId) {
        await appendTraceEvent(sessionId, {
            timestamp: new Date().toISOString(),
            type: "after_tool_call",
            toolName: args.toolName ?? args.tool_name,
            toolCallId: args.toolCallId ?? args.tool_call_id,
            runId: args.runId ?? args.run_id,
            durationMs: args.durationMs ?? args.duration_ms,
            ok: args.error == null,
            error: typeof args.error === "string" ? args.error : undefined,
        }, config);
    }
    await dispatchOmmHooks("after_tool_call", args, config);
}
/** Dispatch user-installed llm_input hooks + record trace. */
export async function handleLlmInput(args, config) {
    const sessionId = extractString(args, "sessionId");
    if (sessionId) {
        await appendTraceEvent(sessionId, {
            timestamp: new Date().toISOString(),
            type: "llm_input",
            provider: args.provider,
            model: args.model,
            runId: args.runId ?? args.run_id,
        }, config);
    }
    await dispatchOmmHooks("llm_input", args, config);
}
/** Dispatch user-installed llm_output hooks + record trace. */
export async function handleLlmOutput(args, config) {
    const sessionId = extractString(args, "sessionId");
    if (sessionId) {
        await appendTraceEvent(sessionId, {
            timestamp: new Date().toISOString(),
            type: "llm_output",
            provider: args.provider,
            model: args.model,
            runId: args.runId ?? args.run_id,
            usage: args.usage,
        }, config);
    }
    await dispatchOmmHooks("llm_output", args, config);
}
/** Dispatch user-installed agent_end hooks + record trace. */
export async function handleAgentEnd(args, config) {
    const sessionId = extractString(args, "sessionId");
    if (sessionId) {
        await appendTraceEvent(sessionId, {
            timestamp: new Date().toISOString(),
            type: "agent_end",
            success: args.success,
            durationMs: args.durationMs ?? args.duration_ms,
        }, config);
    }
    await dispatchOmmHooks("agent_end", args, config);
}
/** Dispatch user-installed subagent_spawning hooks. */
export async function handleSubagentSpawning(args, config) {
    await dispatchOmmHooks("subagent_spawning", args, config);
}
/** Dispatch user-installed subagent_spawned hooks. */
export async function handleSubagentSpawned(args, config) {
    await dispatchOmmHooks("subagent_spawned", args, config);
}
/** Dispatch user-installed subagent_ended hooks. */
export async function handleSubagentEnded(args, config) {
    await dispatchOmmHooks("subagent_ended", args, config);
}
/** Dispatch user-installed gateway_start hooks. */
export async function handleGatewayStart(args, config) {
    await dispatchOmmHooks("gateway_start", args, config);
}
/** Dispatch user-installed gateway_stop hooks. */
export async function handleGatewayStop(args, config) {
    await dispatchOmmHooks("gateway_stop", args, config);
}
function extractString(obj, key) {
    const val = obj[key];
    return typeof val === "string" && val !== "" ? val : undefined;
}
//# sourceMappingURL=omm-hooks.js.map