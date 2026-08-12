/**
 * E5 — Progress Ledger.
 *
 * Replaces the "Turn N/M completed" counter string with a structured record of
 * what the run actually DID: files touched, commands run, evidence outcome. The
 * summary is injected at turn-prepare + retry time + after compaction, so a run
 * (and the model, post-compaction) sees concrete progress instead of a number.
 *
 * Pure functions — no side effects, no I/O. Persistence rides AutopilotState
 * (→ checkpoint at the E1-unified getCheckpointRoot); no second persistence
 * mechanism. A transient per-turn accumulator (in index.ts) collects tool calls
 * within a turn; finalizeTurn stamps + folds it into the ledger.
 */
import type { EvidenceStatus } from './types';

export interface LedgerEntry {
  turn: number;
  filesTouched: string[];
  commandsRun: string[];
  evidenceStatus?: EvidenceStatus;
  /**
   * WHY an evidenceStatus of 'skipped' was skipped. Mirrors EvidenceSummary's
   * skipReason so the ledger — and thus lastProgressTurn — can distinguish
   * 'not_configured' (legitimate: no validation configured → counts as progress)
   * from 'not_executed' (configured but dropped/errored → fail-closed, NOT progress).
   * F6 (ticket 12 §C1): 'skipped'+'not_executed' must not read as forward progress.
   */
  skipReason?: 'not_configured' | 'not_executed';
  /** Model-declared decisions (optional — left empty for now). */
  decisions: string[];
  /** Known incomplete items the model surfaced (optional). */
  openItems: string[];
}

/**
 * F6: does this evidence outcome count as forward progress for the no_progress
 * detector? A turn counts when its evidence was validated ('passed') OR no
 * validation ran this turn (undefined — mid-run turn) OR validation was
 * legitimately absent ('skipped'+'not_configured'). It does NOT count when
 * evidence failed, OR when configured validation was dropped/errored
 * ('skipped'+'not_executed' — fail-closed per evidence-gate.ts).
 */
export function countsAsProgress(
  evidenceStatus: EvidenceStatus | undefined,
  skipReason?: 'not_configured' | 'not_executed',
): boolean {
  if (evidenceStatus === undefined) return true; // mid-run turn, no validation
  if (evidenceStatus === 'passed') return true;
  if (evidenceStatus === 'skipped') return skipReason !== 'not_executed';
  return false; // 'failed' | 'running' | 'not_started'
}

/**
 * Aggregate of the turns folded out of the detail window. This is a MERGED
 * representation (counts + unique files/commands), re-derived on every fold —
 * never a concatenation of per-turn prose. "替换而非叠加" (replace, not stack):
 * folding turn N+1 merges into this aggregate rather than appending a new
 * summary string, so the summary cannot balloon with stacked repetitions.
 */
export interface FoldedAggregate {
  turns: number;
  filesTouched: string[];
  commandsRun: string[];
  /** E2: the turn number of the most recent folded entry whose evidence was
   * not 'failed' — so lastProgressTurn can see validated progress that aged
   * out of the detail window. 0 when no folded turn qualified. */
  lastValidatedTurn: number;
}

export interface Ledger {
  folded: FoldedAggregate;
  /** Most recent N turns (detail), newest last. Bounded by LEDGER_MAX_DETAIL. */
  entries: LedgerEntry[];
}

/** Detail window: keep this many recent turns verbatim, fold older into `folded`. */
export const LEDGER_MAX_DETAIL = 6;
const MAX_FILES_PER_ENTRY = 8;
const MAX_CMDS_PER_ENTRY = 4;
const MAX_SUMMARY_FILES = 12;
const MAX_SUMMARY_CMDS = 8;
const MAX_ITEM_LEN = 120;

export function emptyLedger(): Ledger {
  return { folded: { turns: 0, filesTouched: [], commandsRun: [], lastValidatedTurn: 0 }, entries: [] };
}

/** Clamp/clean a single item (path or command) for storage. */
function cleanItem(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  if (!v) return null;
  return v.length > MAX_ITEM_LEN ? v.substring(0, MAX_ITEM_LEN) : v;
}

/** Build a turn entry from raw per-turn accumulations. Dedupes + caps volume. */
export function buildEntry(
  turn: number,
  filesTouched: string[],
  commandsRun: string[],
  evidenceStatus?: EvidenceStatus,
  skipReason?: 'not_configured' | 'not_executed',
): LedgerEntry {
  const files = dedup(filesTouched.map(cleanItem).filter(Boolean) as string[]).slice(0, MAX_FILES_PER_ENTRY);
  const cmds = dedup(commandsRun.map(cleanItem).filter(Boolean) as string[]).slice(0, MAX_CMDS_PER_ENTRY);
  return { turn, filesTouched: files, commandsRun: cmds, evidenceStatus, skipReason, decisions: [], openItems: [] };
}

function dedup(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * Fold the oldest detail entry into the aggregate, dropping it from `entries`.
 * The aggregate is MERGED (replace representation), not appended — see FoldedAggregate.
 *
 * Review follow-up: cap from the END (slice(-MAX)) so the NEWEST folded files
 * survive. New folded turns are appended last; slicing the head would freeze
 * filesTouchedSoFar at the earliest files ever touched and never reflect later
 * work.
 */
function foldOldest(ledger: Ledger): Ledger {
  if (ledger.entries.length === 0) return ledger;
  const [oldest, ...rest] = ledger.entries;
  // E2: carry the most recent validated turn into the aggregate. If the folded
  // aggregate already saw a validated turn, keep it (it's newer than anything
  // folding in now, since detail is newest-last and we fold oldest-first).
  const carryValidated = countsAsProgress(oldest.evidenceStatus, oldest.skipReason) ? oldest.turn : 0;
  const lastValidatedTurn = Math.max(ledger.folded.lastValidatedTurn ?? 0, carryValidated);
  return {
    folded: {
      turns: ledger.folded.turns + 1,
      filesTouched: dedup([...ledger.folded.filesTouched, ...oldest.filesTouched]).slice(-MAX_SUMMARY_FILES),
      commandsRun: dedup([...ledger.folded.commandsRun, ...oldest.commandsRun]).slice(-MAX_SUMMARY_CMDS),
      lastValidatedTurn,
    },
    entries: rest,
  };
}

/**
 * Finalize a turn: append the entry, then fold while over capacity. Returns a new
 * Ledger (immutable). Pure.
 */
export function recordTurn(ledger: Ledger, entry: LedgerEntry, maxDetail = LEDGER_MAX_DETAIL): Ledger {
  let next: Ledger = { folded: ledger.folded, entries: [...ledger.entries, entry] };
  while (next.entries.length > maxDetail) {
    next = foldOldest(next);
  }
  return next;
}

/**
 * Structured JSON summary for injection. Compact, model-facing (English, not
 * i18n — same as other agent-facing injections). Three surfaces: folded history
 * (aggregate), recent detail turns, and open items from the latest turn.
 *
 * The shape is intentionally JSON (not prose/markdown): a structured artifact
 * the model is less inclined to rewrite, and that compresses well.
 */
export function summarizeLedger(ledger: Ledger | undefined): string {
  const l = ledger ?? emptyLedger();
  const recent = l.entries
    .map((e) => ({
      turn: e.turn,
      files: e.filesTouched,
      commands: e.commandsRun,
      ...(e.evidenceStatus ? { evidence: e.evidenceStatus } : {}),
    }));
  const open = l.entries.length > 0 ? l.entries[l.entries.length - 1].openItems : [];
  const summary = {
    foldedTurns: l.folded.turns,
    filesTouchedSoFar: l.folded.filesTouched,
    commandsRunSoFar: l.folded.commandsRun,
    recentTurns: recent,
    openItems: open,
  };
  return JSON.stringify(summary);
}

/**
 * E2 evidence-coupled accounting: the turn of the last ledger entry that counts
 * as forward progress (see countsAsProgress). A failed-evidence turn produced
 * output but the output was not validated — it does not count. Nor does
 * 'skipped'+'not_executed' (configured validation dropped/errored — fail-closed,
 * F6). Entries with undefined evidenceStatus (mid-run turns) and
 * 'skipped'+'not_configured' (legitimate absence of validation) DO count. Falls
 * back to the folded aggregate's lastValidatedTurn when no detail entry
 * qualifies. Returns 0 if no qualifying turn exists (detail or folded).
 */
export function lastProgressTurn(ledger: Ledger | undefined): number {
  const l = ledger ?? emptyLedger();
  for (let i = l.entries.length - 1; i >= 0; i--) {
    const e = l.entries[i];
    if (countsAsProgress(e.evidenceStatus, e.skipReason)) {
      return e.turn;
    }
  }
  return l.folded.lastValidatedTurn ?? 0;
}

/**
 * Short, human-readable, RPC-safe headline for state.progress (review follow-up:
 * state.progress is returned verbatim by the autopilot.status RPC, so it must NOT
 * hold raw JSON). Consumes the same ledger; the detailed JSON (summarizeLedger)
 * is for agent-facing injections only.
 */
export function buildProgressHeadline(ledger: Ledger | undefined): string {
  const l = ledger ?? emptyLedger();
  const last = l.entries[l.entries.length - 1];
  const turn = last?.turn ?? 0;
  // Dedup across the fold boundary: the folded aggregate is internally deduped
  // but a file/command present in both folded history and the latest turn was
  // double-counted. Union both, then count distinct.
  const fileCount = new Set([...l.folded.filesTouched, ...(last?.filesTouched ?? [])]).size;
  const cmdCount = new Set([...l.folded.commandsRun, ...(last?.commandsRun ?? [])]).size;
  const foldedNote = l.folded.turns > 0 ? ` · ${l.folded.turns} earlier turn${l.folded.turns === 1 ? '' : 's'} folded` : '';
  return `Turn ${turn} · ${fileCount} file${fileCount === 1 ? '' : 's'} · ${cmdCount} command${cmdCount === 1 ? '' : 's'}${foldedNote}`;
}
