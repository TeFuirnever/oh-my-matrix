import { type RalphPrd } from "./omm-ralph-prd.js";
import { type RalphProgressEntry } from "./omm-ralph-progress.js";
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
export declare function getResumePoint(stateRoot?: string): Promise<RalphResumePoint>;
/**
 * Convenience filter: stories from the resume point's PRD with `passes=false`,
 * in declared order. Returns an empty array when no PRD is present.
 */
export declare function pendingStories(resume: RalphResumePoint): RalphPrd["stories"];
