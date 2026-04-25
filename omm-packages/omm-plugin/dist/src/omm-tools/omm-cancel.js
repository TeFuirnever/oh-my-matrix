import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "../omm-config.js";
export async function runOmmCancel(input, config = {}) {
  const sessionId =
    typeof input.sessionId === "string" && input.sessionId.trim() !== ""
      ? input.sessionId
      : null;
  const record = {
    sessionId,
    cancelledAt: new Date().toISOString(),
    message: "session cancelled",
  };
  const stateDir = join(resolveOmmStateRoot(config.stateRoot), "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "cancel.json");
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return {
    content: [{ type: "text", text: "omm cancel: session cancelled" }],
    details: { path, record },
  };
}
//# sourceMappingURL=omm-cancel.js.map
