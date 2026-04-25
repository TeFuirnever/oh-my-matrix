import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";
export function handleSessionStart(_args, config) {
    const stateRoot = resolveOmmStateRoot(config?.stateRoot);
    const stateDir = join(stateRoot, "state");
    mkdirSync(stateDir, { recursive: true });
    const record = {
        event: "session_start",
        timestamp: new Date().toISOString(),
    };
    writeFileSync(join(stateDir, "session.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
export function handleSessionEnd(_args, config) {
    const stateRoot = resolveOmmStateRoot(config?.stateRoot);
    const stateDir = join(stateRoot, "state");
    const record = {
        event: "session_end",
        timestamp: new Date().toISOString(),
    };
    try {
        writeFileSync(join(stateDir, "session.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    }
    catch {
        // State dir may not exist if session_start never fired
    }
}
//# sourceMappingURL=omm-hooks.js.map