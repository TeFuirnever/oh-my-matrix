/** Workflow exclusivity guard — only one of ralph/autopilot/team may be active=true. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export const WORKFLOW_MODES = new Set(["ralph", "autopilot", "team"]);
/** Detect the workflow mode for an incoming state value, or null if not a workflow write. */
function detectWorkflowMode(key, value) {
  const mode = value.mode ?? key;
  return WORKFLOW_MODES.has(mode) ? mode : null;
}
/**
 * True when the two modes are validly linked. Linkage is UNIDIRECTIONAL —
 * only team writes `linked_ralph: true` to declare it was launched by ralph.
 * Ralph never writes any linkage field.
 */
function isLinkedPair(incomingMode, incoming, existingMode, existing) {
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
  stateDir,
  incomingKey,
  incomingValue,
) {
  if (incomingValue.active !== true) return { ok: true };
  const incomingMode = detectWorkflowMode(incomingKey, incomingValue);
  if (!incomingMode) return { ok: true };
  let entries;
  try {
    entries = await readdir(stateDir);
  } catch {
    return { ok: true };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const existingKey = entry.slice(0, -5);
    if (existingKey === incomingKey) continue;
    let parsed;
    try {
      const raw = await readFile(join(stateDir, entry), "utf8");
      parsed = JSON.parse(raw);
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
//# sourceMappingURL=omm-workflow-guard.js.map
