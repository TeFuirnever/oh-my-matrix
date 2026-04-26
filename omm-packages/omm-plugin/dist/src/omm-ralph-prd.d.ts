export declare const PRD_FILENAME = "ralph-prd.json";
export declare const PRD_SCHEMA_VERSION = 1;
export interface RalphStory {
    id: string;
    title: string;
    criteria: string[];
    passes: boolean;
    notes?: string;
}
export interface RalphPrd {
    version: number;
    task: string;
    stories: RalphStory[];
}
export interface PrdLoadResult {
    ok: boolean;
    prd?: RalphPrd;
    error?: string;
}
export interface PrdSaveResult {
    ok: boolean;
    error?: string;
}
/** Validate a candidate object against the PRD schema. */
export declare function validatePrd(value: unknown): {
    ok: boolean;
    error?: string;
};
/** Load the PRD. Returns ok=true with prd=undefined when the file is missing. */
export declare function loadPrd(stateRoot?: string): Promise<PrdLoadResult>;
/** Save the PRD with atomic tmp+rename. Validates structure before writing. */
export declare function savePrd(prd: RalphPrd, stateRoot?: string): Promise<PrdSaveResult>;
/**
 * Mark a single story as passing or failing without touching the rest of
 * the PRD. Returns ok=false when the PRD is missing or the story ID is
 * unknown.
 */
export declare function markStoryPasses(storyId: string, passes: boolean, stateRoot?: string): Promise<PrdSaveResult>;
