/**
 * Ralph resume — composes mode state, PRD, and progress ledger into a
 * single snapshot suitable for cross-session recovery.
 *
 * Best-effort semantics: every component returns null/empty when its file
 * is missing or malformed, rather than throwing. This way a partially-set-up
 * ralph session (e.g., mode started but PRD not written yet) still resumes.
 */
import { getModeState } from "./omm-mode-lifecycle.js";
import { loadPrd, type RalphPrd } from "./omm-ralph-prd.js";
import { loadProgress, type RalphProgressEntry } from "./omm-ralph-progress.js";

export interface RalphResumePoint {
  /** True when ralph mode state exists and `active=true`. */
  active: boolean;
  /** The full ralph mode state record, or null if no `ralph.json` exists. */
  modeState: Record<string, unknown> | null;
  /** Parsed PRD, or null if `ralph-prd.json` is missing. */
  prd: RalphPrd | null;
  /** Progress entries in append order. Empty array when no ledger exists. */
  progress: RalphProgressEntry[];
}

/** Produce a resume snapshot. Reads filesystem; never throws on missing data. */
export async function getResumePoint(
  stateRoot = "",
): Promise<RalphResumePoint> {
  const [modeState, prdResult, progress] = await Promise.all([
    getModeState("ralph", { stateRoot }),
    loadPrd(stateRoot),
    loadProgress(stateRoot),
  ]);
  const prd = prdResult.ok && prdResult.prd ? prdResult.prd : null;
  const active = modeState?.active === true;
  return { active, modeState, prd, progress };
}

/**
 * Convenience filter: stories from the resume point's PRD with `passes=false`,
 * in declared order. Returns an empty array when no PRD is present.
 */
export function pendingStories(resume: RalphResumePoint): RalphPrd["stories"] {
  if (!resume.prd) return [];
  return resume.prd.stories.filter((s) => !s.passes);
}
