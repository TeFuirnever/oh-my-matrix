import { mkdir, writeFile } from "node:fs/promises";
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
/** Dispatch user-installed pre_tool_use hooks. */
export async function handlePreToolUse(args, config) {
    await dispatchOmmHooks("pre_tool_use", args, config);
}
/** Dispatch user-installed post_tool_use hooks. */
export async function handlePostToolUse(args, config) {
    await dispatchOmmHooks("post_tool_use", args, config);
}
/** Dispatch user-installed mode_change hooks. */
export async function handleModeChange(args, config) {
    await dispatchOmmHooks("mode_change", args, config);
}
//# sourceMappingURL=omm-hooks.js.map