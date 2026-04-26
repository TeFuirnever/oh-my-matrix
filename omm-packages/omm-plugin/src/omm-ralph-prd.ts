/**
 * Ralph PRD persistence — load, save, and patch the structured user-story
 * document that drives ralph's iteration loop.
 *
 * Stored at `{stateRoot}/state/ralph-prd.json` separately from the mode
 * state file (`ralph.json`) so progress data survives `cancelMode` and so
 * the workflow exclusivity guard ignores it (the file's resolved key is
 * `ralph-prd`, which is not a workflow mode name).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";

export const PRD_FILENAME = "ralph-prd.json";
export const PRD_SCHEMA_VERSION = 1;

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

function prdPath(stateRoot: string): string {
  return join(resolveOmmStateRoot(stateRoot), "state", PRD_FILENAME);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateStory(value: unknown, idx: number): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `stories[${idx}] must be an object`;
  }
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id.trim() === "") {
    return `stories[${idx}].id must be a non-empty string`;
  }
  if (typeof s.title !== "string") {
    return `stories[${idx}].title must be a string`;
  }
  if (!isStringArray(s.criteria)) {
    return `stories[${idx}].criteria must be a string array`;
  }
  if (typeof s.passes !== "boolean") {
    return `stories[${idx}].passes must be a boolean`;
  }
  if (s.notes !== undefined && typeof s.notes !== "string") {
    return `stories[${idx}].notes must be a string when present`;
  }
  return null;
}

/** Validate a candidate object against the PRD schema. */
export function validatePrd(value: unknown): {
  ok: boolean;
  error?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "PRD must be a JSON object" };
  }
  const v = value as Record<string, unknown>;
  // Forbid `mode` field to prevent collision with the workflow exclusivity
  // guard, which scans all `*.json` files in the state dir and resolves
  // mode via `value.mode ?? key`.
  if (v.mode !== undefined) {
    return {
      ok: false,
      error:
        "PRD must not contain a top-level `mode` field (reserved for workflow guard)",
    };
  }
  if (
    typeof v.version !== "number" ||
    !Number.isInteger(v.version) ||
    v.version < 1
  ) {
    return { ok: false, error: "PRD.version must be a positive integer" };
  }
  if (typeof v.task !== "string") {
    return { ok: false, error: "PRD.task must be a string" };
  }
  if (!Array.isArray(v.stories)) {
    return { ok: false, error: "PRD.stories must be an array" };
  }
  for (let i = 0; i < v.stories.length; i++) {
    const err = validateStory(v.stories[i], i);
    if (err) return { ok: false, error: err };
  }
  // Reject duplicate story IDs to keep markStoryPasses unambiguous.
  const seen = new Set<string>();
  for (const story of v.stories as RalphStory[]) {
    if (seen.has(story.id)) {
      return { ok: false, error: `duplicate story id: ${story.id}` };
    }
    seen.add(story.id);
  }
  return { ok: true };
}

/** Load the PRD. Returns ok=true with prd=undefined when the file is missing. */
export async function loadPrd(stateRoot = ""): Promise<PrdLoadResult> {
  const path = prdPath(stateRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ok: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `PRD file at ${path} is not valid JSON` };
  }
  const v = validatePrd(parsed);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, prd: parsed as RalphPrd };
}

/** Save the PRD with atomic tmp+rename. Validates structure before writing. */
export async function savePrd(
  prd: RalphPrd,
  stateRoot = "",
): Promise<PrdSaveResult> {
  const v = validatePrd(prd);
  if (!v.ok) return { ok: false, error: v.error };
  const dir = join(resolveOmmStateRoot(stateRoot), "state");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, PRD_FILENAME);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(prd, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
  return { ok: true };
}

/**
 * Mark a single story as passing or failing without touching the rest of
 * the PRD. Returns ok=false when the PRD is missing or the story ID is
 * unknown.
 */
export async function markStoryPasses(
  storyId: string,
  passes: boolean,
  stateRoot = "",
): Promise<PrdSaveResult> {
  const r = await loadPrd(stateRoot);
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.prd) return { ok: false, error: "PRD not found" };
  const story = r.prd.stories.find((s) => s.id === storyId);
  if (!story) {
    return { ok: false, error: `story id not found: ${storyId}` };
  }
  const updated: RalphPrd = {
    ...r.prd,
    stories: r.prd.stories.map((s) =>
      s.id === storyId ? { ...s, passes } : s,
    ),
  };
  return savePrd(updated, stateRoot);
}
