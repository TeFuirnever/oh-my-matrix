/** Workflow exclusivity guard — only one team workflow may be active=true. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export const WORKFLOW_MODES = new Set(["team"]);
/** Detect the workflow mode for an incoming state value, or null if not a workflow write. */
function detectWorkflowMode(key, value) {
    const mode = value.mode ?? key;
    return WORKFLOW_MODES.has(mode) ? mode : null;
}
/**
 * Reject `active=true` workflow writes when another workflow mode is already
 * active. Same-key overwrites are allowed.
 */
export async function assertWorkflowExclusivity(stateDir, incomingKey, incomingValue) {
    if (incomingValue.active !== true)
        return { ok: true };
    const incomingMode = detectWorkflowMode(incomingKey, incomingValue);
    if (!incomingMode)
        return { ok: true };
    let entries;
    try {
        entries = await readdir(stateDir);
    }
    catch {
        return { ok: true };
    }
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const existingKey = entry.slice(0, -5);
        if (existingKey === incomingKey)
            continue;
        let parsed;
        try {
            const raw = await readFile(join(stateDir, entry), "utf8");
            parsed = JSON.parse(raw);
        }
        catch {
            continue;
        }
        const existingMode = detectWorkflowMode(existingKey, parsed);
        if (!existingMode)
            continue;
        if (parsed.active !== true)
            continue;
        return {
            ok: false,
            conflictingMode: existingMode,
            error: `cannot activate ${incomingMode}: ${existingMode} is already active (only one workflow mode may be active at a time)`,
        };
    }
    return { ok: true };
}
//# sourceMappingURL=omm-workflow-guard.js.map