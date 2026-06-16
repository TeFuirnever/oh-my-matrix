/** State validation for the omm team workflow skill. */

const TEAM_PHASES = [
  "planning",
  "decomposing",
  "executing",
  "verifying",
  "fixing",
  "delegating",
  "complete",
  "blocked",
  "failed",
] as const;

const TEAM_PHASE_SET = new Set<string>(TEAM_PHASES);

const TERMINAL_PHASES = new Set<string>(["complete", "failed", "blocked"]);

export interface StateValidationResult {
  ok: boolean;
  state?: Record<string, unknown>;
  warning?: string;
  error?: string;
}

function asNonNegInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function asPosInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  return Number.isFinite(Date.parse(value));
}

function normalizePhase(
  raw: unknown,
  validSet: Set<string>,
  label: string,
): { phase?: string; error?: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: `${label} must be a non-empty string` };
  }
  const normalized = raw.trim().toLowerCase();
  if (!validSet.has(normalized)) {
    return { error: `${label} must be one of: ${[...validSet].join(", ")}` };
  }
  return { phase: normalized };
}

function validateTimestamps(next: Record<string, unknown>): string | undefined {
  if (next.startedAt != null && !isIsoTimestamp(next.startedAt)) {
    return "startedAt must be an ISO8601 timestamp";
  }
  if (next.completedAt != null && !isIsoTimestamp(next.completedAt)) {
    return "completedAt must be an ISO8601 timestamp";
  }
  if (next.lastUpdatedAt != null && !isIsoTimestamp(next.lastUpdatedAt)) {
    return "lastUpdatedAt must be an ISO8601 timestamp";
  }
  return undefined;
}

function validateTeam(
  candidate: Record<string, unknown>,
  nowIso: string,
): StateValidationResult {
  const next = { ...candidate };

  if (next.current_phase != null) {
    const r = normalizePhase(
      next.current_phase,
      TEAM_PHASE_SET,
      "team.current_phase",
    );
    if (r.error) return { ok: false, error: r.error };
    next.current_phase = r.phase;
  }

  if (next.active === true) {
    if (next.fix_loop_count == null) next.fix_loop_count = 0;
    if (next.max_fix_loops == null) next.max_fix_loops = 3;
    if (next.current_phase == null) next.current_phase = "planning";
    if (next.startedAt == null) next.startedAt = nowIso;
  }

  if (
    next.fix_loop_count != null &&
    asNonNegInt(next.fix_loop_count) === null
  ) {
    return {
      ok: false,
      error: "team.fix_loop_count must be a non-negative integer",
    };
  }
  if (next.max_fix_loops != null && asPosInt(next.max_fix_loops) === null) {
    return {
      ok: false,
      error: "team.max_fix_loops must be a positive integer",
    };
  }

  // Team uses current_phase for terminal check instead of status
  const phase = next.current_phase as string | undefined;
  if (phase && TERMINAL_PHASES.has(phase)) {
    if (next.active === true) {
      return { ok: false, error: "terminal phase requires active=false" };
    }
    if (next.completedAt == null) {
      next.completedAt = nowIso;
    }
  }

  const tsErr = validateTimestamps(next);
  if (tsErr) return { ok: false, error: tsErr };

  next.lastUpdatedAt = nowIso;
  return { ok: true, state: next };
}

const VALIDATORS: Record<
  string,
  (c: Record<string, unknown>, now: string) => StateValidationResult
> = {
  team: validateTeam,
};

/** Validate and normalize state for a given key. Unknown keys pass through with timestamp only. */
export function validateStateWrite(
  key: string,
  value: Record<string, unknown>,
  options?: { nowIso?: string },
): StateValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "value must be a JSON object" };
  }

  const nowIso = options?.nowIso ?? new Date().toISOString();
  const mode = (value.mode as string | undefined) ?? key;
  const validator = VALIDATORS[mode];

  if (validator) {
    return validator(value, nowIso);
  }

  // Unknown keys: pass through with timestamp
  const next = { ...value, lastUpdatedAt: nowIso };
  return { ok: true, state: next };
}
