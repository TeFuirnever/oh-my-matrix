/**
 * Unified mode lifecycle — host-friendly API over state I/O, validation,
 * the workflow exclusivity guard, and the RunOutcome contract.
 *
 * SKILL.md authors and host integrations call these three primitives instead
 * of hand-rolling state writes:
 *
 *   await startMode("ralph", { task: "..." }, { stateRoot })
 *   await updateModeState("ralph", { iteration: 1, status: "executing" }, ...)
 *   await cancelMode("ralph", "user requested abort", ...)
 *
 * Each primitive composes the existing low-level pieces:
 *   sanitizeStateKey → readStateFile → validateStateWrite
 *   → assertWorkflowExclusivity → atomic tmp+rename
 * and stamps a `RunOutcome` on the record when the run terminates.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";
import { makeRunOutcome, outcomeKindToPhase } from "./omm-run-outcome.js";
import { validateStateWrite } from "./omm-state-validation.js";
import { sanitizeStateKey } from "./omm-tools/omm-state.js";
import { assertWorkflowExclusivity } from "./omm-workflow-guard.js";
// Keep in sync with TERMINAL_PHASES in omm-state-validation.ts.
// `cancelled` is a RunOutcome kind but not a validator-recognized phase,
// so for that case active=false + the outcome record carry the signal.
const VALIDATOR_TERMINAL_PHASES = new Set(["complete", "failed", "blocked"]);
function statePath(stateRoot, key) {
  return join(resolveOmmStateRoot(stateRoot), "state", `${key}.json`);
}
async function readState(stateRoot, key) {
  try {
    const raw = await readFile(statePath(stateRoot, key), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function writeState(stateRoot, key, value) {
  const sanitized = sanitizeStateKey(key);
  if (!sanitized.ok) return { ok: false, error: sanitized.error };
  const safeKey = sanitized.key;
  const validation = validateStateWrite(safeKey, value);
  if (!validation.ok) return { ok: false, error: validation.error };
  const stateDir = join(resolveOmmStateRoot(stateRoot), "state");
  await mkdir(stateDir, { recursive: true });
  const exclusivity = await assertWorkflowExclusivity(
    stateDir,
    safeKey,
    validation.state,
  );
  if (!exclusivity.ok) return { ok: false, error: exclusivity.error };
  const filePath = join(stateDir, `${safeKey}.json`);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(
    tmpPath,
    `${JSON.stringify(validation.state, null, 2)}\n`,
    "utf8",
  );
  await rename(tmpPath, filePath);
  return { ok: true, state: validation.state };
}
/**
 * Start a workflow mode. Writes a fresh active=true record after the
 * exclusivity guard passes. Default counters and status are injected by
 * the existing validator.
 */
export async function startMode(mode, initialFields = {}, config = {}) {
  const value = {
    ...initialFields,
    mode,
    active: true,
  };
  return writeState(config.stateRoot ?? "", mode, value);
}
/**
 * Update an active mode's state. Merges `patch` onto the existing record
 * and re-validates. Refuses when the mode is not currently active to
 * prevent accidental writes that would resurrect a terminated run; callers
 * who need that behavior should use `startMode` instead.
 */
export async function updateModeState(mode, patch, config = {}) {
  const stateRoot = config.stateRoot ?? "";
  const existing = await readState(stateRoot, mode);
  if (!existing) {
    return {
      ok: false,
      error: `${mode} state not found; call startMode first`,
    };
  }
  if (existing.active !== true) {
    return {
      ok: false,
      error: `${mode} is not active (use startMode to start a new run)`,
    };
  }
  const merged = {
    ...existing,
    ...patch,
    mode,
  };
  return writeState(stateRoot, mode, merged);
}
/**
 * Terminate a mode with the given outcome kind. Writes `active=false`,
 * the corresponding terminal phase, and stamps a `RunOutcome` record on
 * the `outcome` field. Idempotent: terminating an already-terminal record
 * is a no-op that returns the existing state.
 */
export async function cancelMode(mode, reason, config = {}) {
  const stateRoot = config.stateRoot ?? "";
  const kind = config.kind ?? "cancelled";
  const existing = await readState(stateRoot, mode);
  if (!existing) {
    return { ok: false, error: `${mode} state not found` };
  }
  if (existing.active !== true) {
    return { ok: true, state: existing };
  }
  const phase = outcomeKindToPhase(kind);
  const phaseField = mode === "team" ? "current_phase" : "status";
  const outcome = makeRunOutcome({ kind, mode, reason });
  const merged = {
    ...existing,
    active: false,
    mode,
    outcome,
  };
  if (VALIDATOR_TERMINAL_PHASES.has(phase)) {
    merged[phaseField] = phase;
  }
  return writeState(stateRoot, mode, merged);
}
/**
 * Read the current state of a mode. Returns null if no state file exists,
 * the parsed record otherwise.
 */
export async function getModeState(mode, config = {}) {
  return readState(config.stateRoot ?? "", mode);
}
//# sourceMappingURL=omm-mode-lifecycle.js.map
