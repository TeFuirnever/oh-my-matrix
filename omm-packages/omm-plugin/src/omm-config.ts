import { homedir } from "node:os";
import { join } from "node:path";

export interface OmmConfig {
  stateRoot?: string;
}

function defaultStateRoot(): string {
  return join(homedir(), ".openclaw", "omm");
}

/** Resolve the omm state directory, defaulting to ~/.openclaw/omm. */
export function resolveOmmStateRoot(configRoot?: unknown): string {
  return typeof configRoot === "string" && configRoot.trim() !== ""
    ? configRoot
    : defaultStateRoot();
}
