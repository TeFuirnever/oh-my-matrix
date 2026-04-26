/**
 * Ralph resume — composes mode state, PRD, and progress ledger into a
 * single snapshot suitable for cross-session recovery.
 *
 * Best-effort semantics: every component returns null/empty when its file
 * is missing or malformed, rather than throwing. This way a partially-set-up
 * ralph session (e.g., mode started but PRD not written yet) still resumes.
 */
import { getModeState } from "./omm-mode-lifecycle.js";
import { loadPrd } from "./omm-ralph-prd.js";
import { loadProgress } from "./omm-ralph-progress.js";
/** Produce a resume snapshot. Reads filesystem; never throws on missing data. */
export async function getResumePoint(stateRoot = "") {
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
export function pendingStories(resume) {
  if (!resume.prd) return [];
  return resume.prd.stories.filter((s) => !s.passes);
}
//# sourceMappingURL=omm-ralph-resume.js.map
