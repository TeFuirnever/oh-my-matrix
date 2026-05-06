import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";
import { getModeState } from "./omm-mode-lifecycle.js";

// ── Shared helpers ──

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function stateDir(stateRoot: string): string {
  return join(resolveOmmStateRoot(stateRoot), "state");
}

// ── PRD ──

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
  return join(stateDir(stateRoot), PRD_FILENAME);
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

export function validatePrd(value: unknown): {
  ok: boolean;
  error?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "PRD must be a JSON object" };
  }
  const v = value as Record<string, unknown>;
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
  const seen = new Set<string>();
  for (const story of v.stories as RalphStory[]) {
    if (seen.has(story.id)) {
      return { ok: false, error: `duplicate story id: ${story.id}` };
    }
    seen.add(story.id);
  }
  return { ok: true };
}

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

export async function savePrd(
  prd: RalphPrd,
  stateRoot = "",
): Promise<PrdSaveResult> {
  const v = validatePrd(prd);
  if (!v.ok) return { ok: false, error: v.error };
  const dir = stateDir(stateRoot);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, PRD_FILENAME);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(prd, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
  return { ok: true };
}

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

// ── Progress ledger ──

export const PROGRESS_FILENAME = "ralph-progress.jsonl";

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

function progressPath(stateRoot: string): string {
  return join(stateDir(stateRoot), PROGRESS_FILENAME);
}

export function validateProgressEntry(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "progress entry must be a JSON object";
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.iteration !== "number" ||
    !Number.isInteger(v.iteration) ||
    v.iteration < 0
  ) {
    return "iteration must be a non-negative integer";
  }
  if (
    typeof v.timestamp !== "string" ||
    !Number.isFinite(Date.parse(v.timestamp))
  ) {
    return "timestamp must be a valid ISO8601 string";
  }
  if (typeof v.summary !== "string") {
    return "summary must be a string";
  }
  if (v.lessons !== undefined && !isStringArray(v.lessons)) {
    return "lessons must be a string array when present";
  }
  return null;
}

export async function appendProgressEntry(
  entry: Omit<RalphProgressEntry, "timestamp"> & { timestamp?: string },
  stateRoot = "",
): Promise<AppendResult> {
  const stamped: RalphProgressEntry = {
    iteration: entry.iteration,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    summary: entry.summary,
    ...(entry.lessons !== undefined ? { lessons: entry.lessons } : {}),
  };
  const err = validateProgressEntry(stamped);
  if (err) return { ok: false, error: err };
  await mkdir(stateDir(stateRoot), { recursive: true });
  await appendFile(
    progressPath(stateRoot),
    `${JSON.stringify(stamped)}\n`,
    "utf8",
  );
  return { ok: true };
}

export async function loadProgress(
  stateRoot = "",
): Promise<RalphProgressEntry[]> {
  let raw: string;
  try {
    raw = await readFile(progressPath(stateRoot), "utf8");
  } catch {
    return [];
  }
  const entries: RalphProgressEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (validateProgressEntry(parsed) === null) {
      entries.push(parsed as RalphProgressEntry);
    }
  }
  return entries;
}

// ── Resume ──

export interface RalphResumePoint {
  active: boolean;
  modeState: Record<string, unknown> | null;
  prd: RalphPrd | null;
  progress: RalphProgressEntry[];
}

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

export function pendingStories(resume: RalphResumePoint): RalphPrd["stories"] {
  if (!resume.prd) return [];
  return resume.prd.stories.filter((s) => !s.passes);
}
