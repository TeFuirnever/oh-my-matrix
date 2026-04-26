import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";

export interface OmmSessionRecord {
  event: "session_start" | "session_end";
  timestamp: string;
  sessionId?: string;
}

async function writeSessionRecord(
  event: OmmSessionRecord["event"],
  config?: { stateRoot?: string },
): Promise<void> {
  const stateRoot = resolveOmmStateRoot(config?.stateRoot);
  const stateDir = join(stateRoot, "state");
  await mkdir(stateDir, { recursive: true });

  const record: OmmSessionRecord = {
    event,
    timestamp: new Date().toISOString(),
  };

  await writeFile(
    join(stateDir, "session.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

/** Write a session_start record to omm state. */
export async function handleSessionStart(
  _args: Record<string, unknown>,
  config?: { stateRoot?: string },
): Promise<void> {
  await writeSessionRecord("session_start", config);
}

/** Write a session_end record to omm state. Silently ignores errors. */
export async function handleSessionEnd(
  _args: Record<string, unknown>,
  config?: { stateRoot?: string },
): Promise<void> {
  try {
    await writeSessionRecord("session_end", config);
  } catch {
    // State dir may not exist if session_start never fired
  }
}
