import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "../omm-config.js";
import { validateStateWrite } from "../omm-state-validation.js";
import { assertWorkflowExclusivity } from "../omm-workflow-guard.js";
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/** Whitelist key to prevent path traversal and filesystem injection. */
export function sanitizeStateKey(raw) {
    if (typeof raw !== "string")
        return { ok: false, error: "key is required" };
    const trimmed = raw.trim();
    if (trimmed === "")
        return { ok: false, error: "key is required" };
    if (!KEY_PATTERN.test(trimmed)) {
        return {
            ok: false,
            error: "key must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)",
        };
    }
    return { ok: true, key: trimmed };
}
/** Write validated JSON state by key with atomic tmp+rename. */
export async function runOmmStateWrite(input, config = {}) {
    const sanitized = sanitizeStateKey(input.key);
    if (!sanitized.ok) {
        return {
            content: [
                { type: "text", text: `omm_state_write error: ${sanitized.error}` },
            ],
            details: { error: sanitized.error },
        };
    }
    const key = sanitized.key;
    if (typeof input.value !== "object" ||
        input.value === null ||
        Array.isArray(input.value)) {
        return {
            content: [
                {
                    type: "text",
                    text: "omm_state_write error: value must be a JSON object",
                },
            ],
            details: { error: "value must be a JSON object" },
        };
    }
    const validation = validateStateWrite(key, input.value);
    if (!validation.ok) {
        return {
            content: [
                { type: "text", text: `omm_state_write error: ${validation.error}` },
            ],
            details: { error: validation.error },
        };
    }
    const stateDir = join(resolveOmmStateRoot(config.stateRoot), "state");
    await mkdir(stateDir, { recursive: true });
    const exclusivity = await assertWorkflowExclusivity(stateDir, key, validation.state);
    if (!exclusivity.ok) {
        return {
            content: [
                { type: "text", text: `omm_state_write error: ${exclusivity.error}` },
            ],
            details: {
                error: exclusivity.error,
                conflictingMode: exclusivity.conflictingMode,
            },
        };
    }
    const filePath = join(stateDir, `${key}.json`);
    const tmpPath = `${filePath}.tmp`;
    const data = `${JSON.stringify(validation.state, null, 2)}\n`;
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, filePath);
    const text = validation.warning
        ? `omm_state_write: ${key} (warning: ${validation.warning})`
        : `omm_state_write: ${key}`;
    return {
        content: [{ type: "text", text }],
        details: { path: filePath, key, state: validation.state },
    };
}
/** Read JSON state by key. Returns null content if not found. */
export async function runOmmStateRead(input, config = {}) {
    const sanitized = sanitizeStateKey(input.key);
    if (!sanitized.ok) {
        return {
            content: [
                { type: "text", text: `omm_state_read error: ${sanitized.error}` },
            ],
            details: { error: sanitized.error },
        };
    }
    const key = sanitized.key;
    const filePath = join(resolveOmmStateRoot(config.stateRoot), "state", `${key}.json`);
    try {
        const data = await readFile(filePath, "utf8");
        return {
            content: [{ type: "text", text: data }],
            details: { path: filePath, key },
        };
    }
    catch {
        return {
            content: [{ type: "text", text: "null" }],
            details: { path: filePath, key, found: false },
        };
    }
}
/** List all state keys. */
export async function runOmmStateList(_input, config = {}) {
    const stateDir = join(resolveOmmStateRoot(config.stateRoot), "state");
    try {
        const files = await readdir(stateDir);
        const keys = files
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.slice(0, -5));
        return {
            content: [{ type: "text", text: JSON.stringify(keys) }],
            details: { keys },
        };
    }
    catch {
        return {
            content: [{ type: "text", text: "[]" }],
            details: { keys: [] },
        };
    }
}
//# sourceMappingURL=omm-state.js.map