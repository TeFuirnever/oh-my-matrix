import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";
function writeSessionRecord(event, config) {
    const stateRoot = resolveOmmStateRoot(config?.stateRoot);
    const stateDir = join(stateRoot, "state");
    mkdirSync(stateDir, { recursive: true });
    const record = {
        event,
        timestamp: new Date().toISOString(),
    };
    writeFileSync(join(stateDir, "session.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
export function handleSessionStart(_args, config) {
    writeSessionRecord("session_start", config);
}
export function handleSessionEnd(_args, config) {
    try {
        writeSessionRecord("session_end", config);
    }
    catch {
        // State dir may not exist if session_start never fired
    }
}
//# sourceMappingURL=omm-hooks.js.map