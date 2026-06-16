/** Workflow exclusivity guard — only one team workflow may be active=true. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const WORKFLOW_MODES = new Set(["team"]);

export interface ExclusivityCheckResult {
  ok: boolean;
  error?: string;
  conflictingMode?: string;
}

/** Detect the workflow mode for an incoming state value, or null if not a workflow write. */
function detectWorkflowMode(
  key: string,
  value: Record<string, unknown>,
): string | null {
  const mode = (value.mode as string | undefined) ?? key;
  return WORKFLOW_MODES.has(mode) ? mode : null;
}

/**
 * Reject `active=true` workflow writes when another workflow mode is already
 * active. Same-key overwrites are allowed.
 */
export async function assertWorkflowExclusivity(
  stateDir: string,
  incomingKey: string,
  incomingValue: Record<string, unknown>,
): Promise<ExclusivityCheckResult> {
  if (incomingValue.active !== true) return { ok: true };
  const incomingMode = detectWorkflowMode(incomingKey, incomingValue);
  if (!incomingMode) return { ok: true };

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    return { ok: true };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const existingKey = entry.slice(0, -5);
    if (existingKey === incomingKey) continue;

    let parsed: Record<string, unknown>;
    try {
      const raw = await readFile(join(stateDir, entry), "utf8");
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const existingMode = detectWorkflowMode(existingKey, parsed);
    if (!existingMode) continue;
    if (parsed.active !== true) continue;

    return {
      ok: false,
      conflictingMode: existingMode,
      error: `cannot activate ${incomingMode}: ${existingMode} is already active (only one workflow mode may be active at a time)`,
    };
  }

  return { ok: true };
}
