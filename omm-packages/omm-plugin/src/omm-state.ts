import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";

export { resolveOmmStateRoot };

export interface OmmSmokeRecord {
  message: string;
  commandName: string | null;
  skillName: string | null;
  createdAt: string;
}

export async function writeOmmSmokeRecord(
  record: OmmSmokeRecord,
  configRoot?: unknown,
): Promise<string> {
  const stateDir = join(resolveOmmStateRoot(configRoot), "state");
  await mkdir(stateDir, { recursive: true });
  const targetPath = join(stateDir, "smoke.json");
  await writeFile(
    `${targetPath}.tmp`,
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  await writeFile(targetPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return targetPath;
}
