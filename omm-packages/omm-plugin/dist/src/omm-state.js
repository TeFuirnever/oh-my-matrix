import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";
export { resolveOmmStateRoot };
export async function writeOmmSmokeRecord(record, configRoot) {
  const stateDir = join(resolveOmmStateRoot(configRoot), "state");
  await mkdir(stateDir, { recursive: true });
  const targetPath = join(stateDir, "smoke.json");
  const tmpPath = `${targetPath}.tmp`;
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, targetPath);
  return targetPath;
}
//# sourceMappingURL=omm-state.js.map
