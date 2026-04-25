import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "../omm-config.js";
import { normalizeNullableText } from "./omm-ping.js";
export async function runOmmCancel(input, config = {}) {
    const sessionId = normalizeNullableText(input.sessionId);
    const record = {
        sessionId,
        cancelledAt: new Date().toISOString(),
        message: "session cancelled",
    };
    const stateDir = join(resolveOmmStateRoot(config.stateRoot), "state");
    await mkdir(stateDir, { recursive: true });
    const path = join(stateDir, "cancel.json");
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tmpPath, path);
    return {
        content: [{ type: "text", text: "omm cancel: session cancelled" }],
        details: { path, record },
    };
}
//# sourceMappingURL=omm-cancel.js.map