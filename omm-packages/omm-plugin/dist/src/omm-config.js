import { homedir } from "node:os";
import { join } from "node:path";
function defaultStateRoot() {
    return join(homedir(), ".openclaw", "omm");
}
/** Resolve the omm state directory, defaulting to ~/.openclaw/omm. */
export function resolveOmmStateRoot(configRoot) {
    return typeof configRoot === "string" && configRoot.trim() !== ""
        ? configRoot
        : defaultStateRoot();
}
//# sourceMappingURL=omm-config.js.map