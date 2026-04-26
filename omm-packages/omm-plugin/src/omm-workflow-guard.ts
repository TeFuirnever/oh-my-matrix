/** Workflow exclusivity guard — only one of ralph/autopilot/team may be active=true. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const WORKFLOW_MODES = new Set(["ralph", "autopilot", "team"]);

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
 * True when the two modes are validly linked. Linkage is UNIDIRECTIONAL —
 * only team writes `linked_ralph: true` to declare it was launched by ralph.
 * Ralph never writes any linkage field.
 */
function isLinkedPair(
  incomingMode: string,
  incoming: Record<string, unknown>,
  existingMode: string,
  existing: Record<string, unknown>,
): boolean {
  if (incomingMode === "ralph" && existingMode === "team") {
    return existing.linked_ralph === true;
  }
  if (incomingMode === "team" && existingMode === "ralph") {
    return incoming.linked_ralph === true;
  }
  return false;
}

/**
 * Reject `active=true` workflow writes when another workflow mode is already
 * active. Same-key overwrites and linked ralph↔team pairs are allowed.
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
    if (isLinkedPair(incomingMode, incomingValue, existingMode, parsed))
      continue;

    return {
      ok: false,
      conflictingMode: existingMode,
      error: `cannot activate ${incomingMode}: ${existingMode} is already active (only one workflow mode may be active at a time)`,
    };
  }

  return { ok: true };
}
