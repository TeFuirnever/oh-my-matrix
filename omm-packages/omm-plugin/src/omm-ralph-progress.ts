/**
 * Ralph progress ledger — append-only JSONL record of iteration outcomes.
 *
 * Stored at `{stateRoot}/state/ralph-progress.jsonl`. Each line is one JSON
 * object: `{ iteration, timestamp, summary, lessons?: string[] }`.
 *
 * Append uses `appendFile` (single small write — the OS-level atomicity for
 * sub-PIPE_BUF writes is good enough for ralph's metadata use case). On read
 * we tolerate partial trailing lines from a crashed mid-write rather than
 * losing the whole ledger.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOmmStateRoot } from "./omm-config.js";

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
  return join(resolveOmmStateRoot(stateRoot), "state", PROGRESS_FILENAME);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Validate an entry candidate. Returns null when valid, an error string otherwise. */
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

/**
 * Append one progress entry. Auto-stamps `timestamp` when omitted. Validates
 * structure before writing.
 */
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
  const dir = join(resolveOmmStateRoot(stateRoot), "state");
  await mkdir(dir, { recursive: true });
  const path = progressPath(stateRoot);
  await appendFile(path, `${JSON.stringify(stamped)}\n`, "utf8");
  return { ok: true };
}

/**
 * Load all valid progress entries. Lines that fail to parse or fail
 * validation are silently skipped — the ledger is best-effort metadata,
 * not authoritative state.
 */
export async function loadProgress(
  stateRoot = "",
): Promise<RalphProgressEntry[]> {
  const path = progressPath(stateRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
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
