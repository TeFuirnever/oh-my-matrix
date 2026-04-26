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
/** Validate an entry candidate. Returns null when valid, an error string otherwise. */
export declare function validateProgressEntry(value: unknown): string | null;
/**
 * Append one progress entry. Auto-stamps `timestamp` when omitted. Validates
 * structure before writing.
 */
export declare function appendProgressEntry(
  entry: Omit<RalphProgressEntry, "timestamp"> & {
    timestamp?: string;
  },
  stateRoot?: string,
): Promise<AppendResult>;
/**
 * Load all valid progress entries. Lines that fail to parse or fail
 * validation are silently skipped — the ledger is best-effort metadata,
 * not authoritative state.
 */
export declare function loadProgress(
  stateRoot?: string,
): Promise<RalphProgressEntry[]>;
