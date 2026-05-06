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
export declare function validatePrd(value: unknown): {
    ok: boolean;
    error?: string;
};
export declare function loadPrd(stateRoot?: string): Promise<PrdLoadResult>;
export declare function savePrd(prd: RalphPrd, stateRoot?: string): Promise<PrdSaveResult>;
export declare function markStoryPasses(storyId: string, passes: boolean, stateRoot?: string): Promise<PrdSaveResult>;
export declare const PROGRESS_FILENAME = "ralph-progress.jsonl";
export interface RalphProgressEntry {
    iteration: number;
    timestamp: string;
    summary: string;
    lessons?: string[];
}
export interface AppendResult {
    ok: boolean;
    error?: string;
}
export declare function validateProgressEntry(value: unknown): string | null;
export declare function appendProgressEntry(entry: Omit<RalphProgressEntry, "timestamp"> & {
    timestamp?: string;
}, stateRoot?: string): Promise<AppendResult>;
export declare function loadProgress(stateRoot?: string): Promise<RalphProgressEntry[]>;
export interface RalphResumePoint {
    active: boolean;
    modeState: Record<string, unknown> | null;
    prd: RalphPrd | null;
    progress: RalphProgressEntry[];
}
export declare function getResumePoint(stateRoot?: string): Promise<RalphResumePoint>;
export declare function pendingStories(resume: RalphResumePoint): RalphPrd["stories"];
