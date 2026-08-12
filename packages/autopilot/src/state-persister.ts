/**
 * Crash-recovery checkpoint persistence for autopilot run state.
 *
 * Writes a SLIM pointer of AutopilotState to
 *   {workspaceRoot}/.autopilot/checkpoints/{runId}.json
 * plus a sessionKey→runId index at
 *   {workspaceRoot}/.autopilot/checkpoints/session-index.json
 *
 * Design (mirrors @oh-my-matrix/permission-policy/src/audit-persister.ts):
 *   - synchronous file I/O (plugin runs in main process; simplicity > async)
 *   - fail-silent (never throws; persistence is best-effort recovery, not authoritative)
 *   - no external dependencies
 *
 * ADR-016 invariant (status sole-writer): `status` is NEVER trusted from disk.
 * On load, status is re-derived via deriveStatus(). We persist a `status` field
 * only as a forensic hint; loaders MUST overwrite it with the derived value.
 * This prevents the H1 false-completion class from recurring via stale checkpoints.
 *
 * Review #4 BLOCKERs addressed here:
 *   #1 (status re-derive) — loadCheckpoint re-derives via deriveStatus
 *   #2 (runId recovery) — session-index.json maps sessionKey→runId durably
 *   #3 (write concurrency) — per-runId Promise lock serializes writes
 *   #5 (atomic same-dir write) — tmp written next to target, not os.tmpdir()
 *   #6 (done-run leak) — deleteCheckpoint called on terminal transitions
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AutopilotState } from './types';
import type { WorkspaceRecord, RetryEntry, WorkflowConfig, EvidenceSummary } from './types';
import { DEFAULT_CONFIG } from './types';
import { deriveStatus } from './orchestrator';
import type { Ledger } from './progress-ledger';

const CHECKPOINT_SUBDIR = path.join('.autopilot', 'checkpoints');
const SESSION_INDEX_FILE = 'session-index.json';
const TERMINAL_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000; // sweep terminal checkpoints older than 24h

/**
 * Checkpoint schema version (ticket 08). Bumped on every breaking change to the
 * persisted shape. v1 = pre-02 (no ledger / no lastValidatedTurn / evidenceStatus
 * string only). v2 = 02 + 08 (ledger with lastValidatedTurn + full EvidenceSummary).
 * loadCheckpoint runs migrateCheckpoint() to bring older disks up to v2; a
 * schemaVersion NEWER than this (from a downgraded build) is refused, not
 * silently misinterpreted — see F3 / ticket 08.
 */
const CHECKPOINT_SCHEMA_VERSION = 2;

let _writeFailureCount = 0;
export function getCheckpointWriteFailureCount(): number { return _writeFailureCount; }
export function _resetCheckpointFailureCountForTest(): void { _writeFailureCount = 0; }

/**
 * Test-only kill switch. When true, saveCheckpoint/deleteCheckpoint/listResumableCheckpoints
 * become no-ops so the existing 50+ test suite (which runs in the repo root and would
 * otherwise leak checkpoint files across tests, polluting stateByRun via the
 * register()-time restore) stays isolated. Production never sets this. Flipped to
 * true by index.ts _resetForTest(); flipped back false by _enableCheckpointingForTest()
 * in tests that exercise persistence (state-persister.test.ts).
 */
let _checkpointingDisabledForTest = false;
export function _disableCheckpointingForTest(): void { _checkpointingDisabledForTest = true; }
export function _enableCheckpointingForTest(): void { _checkpointingDisabledForTest = false; }
export function _isCheckpointingDisabledForTest(): boolean { return _checkpointingDisabledForTest; }

/**
 * E1 / P0-2: the checkpoint root is a FIXED user-level location, decoupled from
 * the run's workspace. Previously writes landed at `state.workspace.root` (or
 * process.cwd()) while reads hardcoded process.cwd() — so a run activated with a
 * configured workspacePath was structurally unrecoverable (its checkpoint sat in
 * the workspace dir; reads scanned the gateway cwd). A checkpoint is engine
 * coordination state, not workspace content (ADR-008), so it lives under the
 * user's matrix dir, not the workspace. `state.workspace` is still persisted ON
 * the checkpoint (containment boundary) — only the FILE LOCATION is decoupled.
 *
 * The persister functions still take a `workspaceRoot` and append
 * `.autopilot/checkpoints`; callers pass this fixed root so the dir resolves to
 * `~/.matrix/.autopilot/checkpoints`.
 */
let _checkpointRootOverride: string | undefined;
export function _setCheckpointRootForTest(root: string | undefined): void { _checkpointRootOverride = root; }
export function getCheckpointRoot(): string {
  return _checkpointRootOverride ?? path.join(os.homedir(), '.matrix');
}

/**
 * Resolve the checkpoint directory for a workspace root, following symlinks
 * (S12: same canonical-path discipline as audit-persister).
 */
function getCheckpointDir(workspaceRoot: string): string {
  let resolved = workspaceRoot;
  try {
    resolved = fs.realpathSync(workspaceRoot);
  } catch {
    // Path may not exist yet (mkdirSync creates it downstream).
  }
  return path.join(resolved, CHECKPOINT_SUBDIR);
}

function getCheckpointPath(workspaceRoot: string, runId: string): string {
  return path.join(getCheckpointDir(workspaceRoot), `${runId}.json`);
}

function getSessionIndexPath(workspaceRoot: string): string {
  return path.join(getCheckpointDir(workspaceRoot), SESSION_INDEX_FILE);
}

/**
 * The slim persisted shape. Intentionally a SUBSET of AutopilotState — we do NOT
 * persist permissionAudit (it has its own JSONL via audit-persister), nor status
 * (re-derived on load). Large/ephemeral fields (canaryFired, noUsageWarned) are
 * session-scoped and never persisted.
 */
export interface AutopilotCheckpoint {
  /** ticket 08: schema version for migration. Absent on v1 (pre-02) checkpoints. */
  schemaVersion?: number;
  runId: string;
  sessionKey: string;
  orchestrationState?: AutopilotState['orchestrationState'];
  blockedReason?: AutopilotState['blockedReason'];
  goal?: string;
  goalSnapshot?: string;
  progress?: string;
  progressSnapshot?: string;
  turnAttempts: number;
  totalContinuations: number;
  maxAttemptsPerTurn: number;
  maxTotalContinuations: number;
  toolErrorThreshold: number;
  maxConcurrentAutopilot: number;
  needsCrossTurnResume: boolean;
  enabled: boolean;
  totalTokensUsed: number;
  tokenBudget?: number;
  /** E2: per-run hard caps restored on crash recovery. */
  maxDurationMs?: number;
  maxCostUsd?: number;
  /** E5: progress ledger (bounded). */
  ledger?: Ledger;
  /** E4: completion reached without a passed evidence gate (observability). */
  completionUnverified?: boolean;
  inputTokensUsed?: number;
  outputTokensUsed?: number;
  /** ticket 08: full evidence summary, restored on load so crash recovery does
   * not blank projection/continuation-engine (which read state.evidence). */
  evidence?: EvidenceSummary;
  /** Legacy (v1) field: just the status string. Kept for backward-compat reads
   * of pre-08 checkpoints; new writes populate `evidence` instead. */
  evidenceStatus?: AutopilotState['evidence'] extends infer E ? (E extends { status: infer S } ? S : undefined) : undefined;
  startedAt?: number;
  lastActivityAt?: number;
  /** Forensic only — loaders overwrite with deriveStatus(). Never trusted. */
  status?: AutopilotState['status'];
  workspaceRoot?: string;
  workspacePath?: string;
  /** Full workspace record (Reviewer #1 Finding 2a fix): restored runs MUST retain
   * their permission-containment boundary + checkpoint-root. Persisting flat fields
   * alone left state.workspace undefined after restore, widening the tool-call
   * containment to process.cwd() — a security regression. */
  workspace?: WorkspaceRecord;
  /** Retry entry (Reviewer #1 Finding 2b fix): without this, restored retry_queued
   * runs lose state.retry → the stall interval's retry_due guard
   * (state.retry?.nextRetryAt != null) is never satisfied → the run wedges forever. */
  retry?: RetryEntry;
  /** Workflow config (Reviewer #1 Finding 2c fix): restored runs otherwise skip
   * validation commands, reset stallTimeoutMs, and lose modelRouting. */
  workflow?: WorkflowConfig;
  /** Enhancement C (ADR-019): per-run trust decision; without this a crashed
   * trusted-verifiable run silently degrades the early-completion threshold
   * (3 -> 2) on recovery. Must be in the allowlist, not auto-serialized. */
  trustWorkspace?: boolean;
  /** Millisecond epoch of the checkpoint write. */
  savedAt: number;
}

/**
 * Build a slim checkpoint from a full AutopilotState. Extracts only the fields
 * needed to resume a run; drops the bulky/ephemeral ones.
 */
export function buildCheckpoint(state: AutopilotState, runId: string, workspaceRoot: string): AutopilotCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId,
    sessionKey: state.sessionKey,
    orchestrationState: state.orchestrationState,
    blockedReason: state.blockedReason,
    goal: state.goal,
    goalSnapshot: state.goalSnapshot,
    progress: state.progress,
    progressSnapshot: state.progressSnapshot,
    turnAttempts: state.turnAttempts,
    totalContinuations: state.totalContinuations,
    maxAttemptsPerTurn: state.maxAttemptsPerTurn,
    maxTotalContinuations: state.maxTotalContinuations,
    toolErrorThreshold: state.toolErrorThreshold,
    maxConcurrentAutopilot: state.maxConcurrentAutopilot,
    needsCrossTurnResume: state.needsCrossTurnResume,
    enabled: state.enabled,
    totalTokensUsed: state.totalTokensUsed,
    tokenBudget: state.tokenBudget,
    maxDurationMs: state.maxDurationMs,
    maxCostUsd: state.maxCostUsd,
    ledger: state.ledger,
    completionUnverified: state.completionUnverified,
    inputTokensUsed: state.inputTokensUsed,
    outputTokensUsed: state.outputTokensUsed,
    evidence: state.evidence,
    evidenceStatus: state.evidence?.status,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt,
    // Forensic hint only — loadCheckpoint overwrites this with deriveStatus().
    status: state.status,
    workspaceRoot,
    workspacePath: state.workspace?.path,
    workspace: state.workspace,
    retry: state.retry,
    workflow: state.workflow,
    trustWorkspace: state.trustWorkspace,
    savedAt: Date.now(),
  };
}

// ─── Per-runId write lock (Review #4 #3a) ──────────────────────────────
// Serializes concurrent saveCheckpoint calls for the same runId across the
// 60s stall timer context and async hook handler contexts. A bare Map<runId,
// Promise> chain — each write awaits the previous one before starting.
const writeLocks = new Map<string, Promise<void>>();

/**
 * Atomic write: tmp file in the SAME directory as the target (NOT os.tmpdir(),
 * which can be on a different volume on Windows → EXDEV). renameSync is atomic
 * on POSIX same-filesystem; Node ≥10 overwrites the target.
 */
function atomicWriteFileSync(targetPath: string, data: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  // PID + random suffix guards against same-dir tmp collisions under concurrency.
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, data, 'utf-8');
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Persist a checkpoint + update the sessionKey→runId index. Fail-silent.
 * Serialized per-runId so concurrent setState firings don't interleave writes.
 *
 * Returns a Promise (rather than sync) because the lock chain is async; callers
 * that don't need to await (the common case from setState) fire-and-forget via
 * void. The internal _writeSyncLocked does the actual sync I/O under the lock.
 */
export function saveCheckpoint(state: AutopilotState, runId: string, workspaceRoot: string): void {
  if (_checkpointingDisabledForTest) return; // test isolation: don't touch disk
  const checkpoint = buildCheckpoint(state, runId, workspaceRoot);
  const targetPath = getCheckpointPath(workspaceRoot, runId);

  // Chain onto any in-flight write for this runId.
  const prev = writeLocks.get(runId) ?? Promise.resolve();
  const next = prev.then(() => {
    try {
      atomicWriteFileSync(targetPath, JSON.stringify(checkpoint));
      updateSessionIndex(workspaceRoot, checkpoint.sessionKey, runId);
    } catch (e) {
      _writeFailureCount++;
      try { console.error('[autopilot] checkpoint save failed:', e); } catch { /* noop */ }
    }
  }).catch(() => {
    // Lock chain errors are already logged inside _writeSyncLocked; swallow to
    // keep the chain alive for the next write.
  });
  writeLocks.set(runId, next);
  // Auto-clean the lock entry once settled so the Map doesn't grow unbounded.
  void next.then(() => {
    if (writeLocks.get(runId) === next) writeLocks.delete(runId);
  });
}

/** Update the sessionKey→runId index atomically. Fail-silent. */
function updateSessionIndex(workspaceRoot: string, sessionKey: string, runId: string): void {
  const indexPath = getSessionIndexPath(workspaceRoot);
  let index: Record<string, string> = {};
  try {
    if (fs.existsSync(indexPath)) {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as Record<string, string>;
    }
  } catch {
    // Corrupt index — start fresh rather than crash.
    index = {};
  }
  if (index[sessionKey] === runId) return; // no-op if unchanged
  index[sessionKey] = runId;
  try {
    atomicWriteFileSync(indexPath, JSON.stringify(index));
  } catch (e) {
    _writeFailureCount++;
    try { console.error('[autopilot] session-index update failed:', e); } catch { /* noop */ }
  }
}

/**
 * ticket 08: bring a deserialized checkpoint up to CHECKPOINT_SCHEMA_VERSION.
 * Pure (no I/O). Returns the migrated checkpoint, or null if the schema is a
 * NEWER version than this build understands (refuse — don't silently
 * misinterpret fields written by a future build).
 *
 * v1 → v2 normalizes:
 *   - ledger.folded.lastValidatedTurn: absent on pre-02 checkpoints. The folded
 *     aggregate has already merged per-turn evidence away, so the historical
 *     validated turn cannot be re-derived — default to 0 (conservative; does not
 *     worsen the F3 regression since detail entries still carry their own
 *     evidenceStatus and lastProgressTurn reads those first).
 *   - evidence: pre-08 stored only the evidenceStatus string. Reconstruct a
 *     minimal EvidenceSummary { status, commands: [] } so state.evidence is
 *     non-undefined after load (projection / continuation-engine degrade
 *     gracefully rather than reading undefined).
 */
function migrateCheckpoint(cp: AutopilotCheckpoint): AutopilotCheckpoint | null {
  // Future schema → refuse. A downgraded build must not misread a newer shape.
  if (cp.schemaVersion !== undefined && cp.schemaVersion > CHECKPOINT_SCHEMA_VERSION) {
    try {
      console.error(
        `[autopilot] checkpoint schemaVersion ${cp.schemaVersion} newer than supported ` +
        `${CHECKPOINT_SCHEMA_VERSION} (run ${cp.runId}) — refusing to load`,
      );
    } catch { /* noop */ }
    return null;
  }

  const migrated: AutopilotCheckpoint = { ...cp };

  // v1 → v2: backfill folded.lastValidatedTurn if the ledger predates 02.
  if (migrated.ledger && migrated.ledger.folded && migrated.ledger.folded.lastValidatedTurn === undefined) {
    migrated.ledger = {
      ...migrated.ledger,
      folded: { ...migrated.ledger.folded, lastValidatedTurn: 0 },
    };
  }

  // v1 → v2: reconstruct minimal evidence from the legacy status string so
  // state.evidence is non-undefined after load (projection/continuation-engine
  // get a degraded-but-present summary rather than undefined).
  if (migrated.evidence === undefined && migrated.evidenceStatus !== undefined) {
    migrated.evidence = { status: migrated.evidenceStatus, commands: [] };
  }

  return migrated;
}

/**
 * Load a checkpoint and rebuild an AutopilotState. ADR-016 BLOCKER #1 fix:
 * `status` is NEVER trusted from the persisted field — always re-derived.
 *
 * Returns null if the checkpoint is missing, corrupt, or fails workspace
 * validation (Review #4 #4: stale-run guard).
 */
export function loadCheckpoint(
  runId: string,
  workspaceRoot: string,
  options?: { validateWorkspace?: boolean },
): AutopilotState | null {
  const cpPath = getCheckpointPath(workspaceRoot, runId);
  let cp: AutopilotCheckpoint;
  try {
    const raw = fs.readFileSync(cpPath, 'utf-8');
    cp = JSON.parse(raw) as AutopilotCheckpoint;
  } catch {
    return null; // missing or corrupt — nothing to resume
  }

  // ticket 08: migrate to the current schema. A future-version checkpoint
  // (newer than this build supports) → null (refuse, don't misinterpret).
  const migrated = migrateCheckpoint(cp);
  if (migrated === null) return null;
  cp = migrated;

  // Review #4 #4: stale-run guard. If the workspace path recorded at checkpoint
  // time no longer exists (deleted between crash and restart), refuse to resume
  // rather than resurrecting a run against a vanished workspace.
  if (options?.validateWorkspace !== false && cp.workspacePath) {
    try {
      const stat = fs.statSync(cp.workspacePath);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
  }

  // Rebuild a minimal AutopilotState. Many fields have safe defaults; the
  // load-bearing ones (orchestrationState, blockedReason, goal, counters,
  // workspace, retry, workflow) come from the checkpoint.
  const partial = {
    sessionKey: cp.sessionKey,
    runId: cp.runId,
    orchestrationState: cp.orchestrationState,
    blockedReason: cp.blockedReason,
    goal: cp.goal,
    goalSnapshot: cp.goalSnapshot,
    progress: cp.progress,
    progressSnapshot: cp.progressSnapshot,
    turnAttempts: cp.turnAttempts,
    totalContinuations: cp.totalContinuations,
    maxAttemptsPerTurn: cp.maxAttemptsPerTurn,
    maxTotalContinuations: cp.maxTotalContinuations,
    maxConcurrentAutopilot: cp.maxConcurrentAutopilot ?? DEFAULT_CONFIG.maxConcurrentAutopilot,
    needsCrossTurnResume: cp.needsCrossTurnResume,
    enabled: cp.enabled,
    totalTokensUsed: cp.totalTokensUsed,
    tokenBudget: cp.tokenBudget,
    maxDurationMs: cp.maxDurationMs,
    maxCostUsd: cp.maxCostUsd,
    ledger: cp.ledger,
    completionUnverified: cp.completionUnverified,
    // ticket 08 / F3-related: restore the full evidence summary (was lost — only
    // the status string was persisted pre-08). migrateCheckpoint reconstructs a
    // minimal summary from the legacy string when cp.evidence is absent.
    evidence: cp.evidence,
    inputTokensUsed: cp.inputTokensUsed,
    outputTokensUsed: cp.outputTokensUsed,
    startedAt: cp.startedAt,
    lastActivityAt: cp.lastActivityAt,
    degraded: true, // mark resumed runs — operators can tell a restored run
    toolErrorCount: 0,
    toolErrorThreshold: cp.toolErrorThreshold ?? DEFAULT_CONFIG.toolErrorThreshold,
    // Reviewer #1 Finding 2a/2b/2c fixes: restore the three load-bearing
    // objects the original "slim pointer" design dropped. Without workspace,
    // the permission containment boundary widens to process.cwd(); without
    // retry, retry_queued runs wedge; without workflow, validation is skipped.
    workspace: cp.workspace,
    retry: cp.retry,
    workflow: cp.workflow,
    trustWorkspace: cp.trustWorkspace,
  } as AutopilotState;

  // BLOCKER #1: re-derive status. Never trust cp.status.
  const derivedStatus = deriveStatus(partial);
  return { ...partial, status: derivedStatus };
}

/**
 * Delete a checkpoint file (Review #4 #6: called on terminal transitions to
 * prevent done-run file leaks). Fail-silent.
 */
export function deleteCheckpoint(runId: string, workspaceRoot: string): void {
  if (_checkpointingDisabledForTest) return; // test isolation: don't touch disk
  const cpPath = getCheckpointPath(workspaceRoot, runId);
  try {
    if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);
  } catch (e) {
    try { console.error('[autopilot] checkpoint delete failed:', e); } catch { /* noop */ }
  }
  // Best-effort index cleanup — leave stale sessionKey→runId entries; they're
  // cheap and the index is rewritten on every save. A full GC pass would risk
  // racing an in-flight save for a different runId.
}

/**
 * Remove a sessionKey→runId entry from the index. Used when a run terminates
 * so a future session_start for the same sessionKey doesn't resurrect a dead run.
 */
export function clearSessionIndexEntry(workspaceRoot: string, sessionKey: string): void {
  const indexPath = getSessionIndexPath(workspaceRoot);
  try {
    if (!fs.existsSync(indexPath)) return;
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as Record<string, string>;
    if (!(sessionKey in index)) return;
    delete index[sessionKey];
    atomicWriteFileSync(indexPath, JSON.stringify(index));
  } catch {
    // fail-silent
  }
}

/**
 * Look up runId by sessionKey from the durable index. Returns null if the
 * index is missing, corrupt, or has no entry. This is BLOCKER #2's recovery
 * path: after a process restart, the in-memory sessionKeyToRunId Map is empty,
 * so session_start must consult this file to find the checkpoint.
 */
export function lookupRunIdBySessionKey(workspaceRoot: string, sessionKey: string): string | null {
  const indexPath = getSessionIndexPath(workspaceRoot);
  try {
    if (!fs.existsSync(indexPath)) return null;
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as Record<string, string>;
    return index[sessionKey] ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan the checkpoints directory and return all runIds whose checkpoint is
 * resumable (orchestrationState in the active family) and whose workspace still
 * exists. Used by register() at process init to restore ALL resumable runs,
 * not just the one whose session_start fired (Review #3 multi-run gap).
 *
 * Also sweeps terminal checkpoints older than TERMINAL_CHECKPOINT_TTL_MS to
 * reclaim disk (Review #4 #6c).
 */
export function listResumableCheckpoints(workspaceRoot: string): string[] {
  if (_checkpointingDisabledForTest) return []; // test isolation: don't read disk
  const dir = getCheckpointDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  let files: string[];
  try {
    const all = fs.readdirSync(dir);
    // E1 / §5.8: sweep `.tmp.*` orphans left by a crash mid-atomicWriteFileSync
    // (the tmp file is written beside the target, then renamed; a crash between
    // leaves garbage). Always stale — unlink on sight during the directory scan.
    for (const f of all) {
      if (f.includes('.tmp.')) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* fail-silent */ }
      }
    }
    files = all.filter(f => f.endsWith('.json') && f !== SESSION_INDEX_FILE);
  } catch {
    return [];
  }
  const resumable: string[] = [];
  const now = Date.now();
  for (const f of files) {
    const runId = f.replace(/\.json$/, '');
    const fullPath = path.join(dir, f);
    try {
      const cp = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as AutopilotCheckpoint;
      const orch = cp.orchestrationState;
      const isResumable = orch === 'running' || orch === 'claimed' || orch === 'retry_queued' || orch === 'released' || orch === 'unclaimed';
      const isTerminal = orch === 'done' || (orch === 'blocked' && cp.blockedReason && !isResumableBlockedReason(cp.blockedReason));

      if (isTerminal) {
        // Review #4 #6c: sweep stale terminal checkpoints.
        if (cp.savedAt && (now - cp.savedAt) > TERMINAL_CHECKPOINT_TTL_MS) {
          try { fs.unlinkSync(fullPath); } catch { /* fail-silent */ }
        }
        continue;
      }
      if (isResumable) {
        // Validate workspace still exists before offering to resume.
        if (cp.workspacePath) {
          try {
            const stat = fs.statSync(cp.workspacePath);
            if (!stat.isDirectory()) continue;
          } catch {
            continue; // workspace gone — skip
          }
        }
        resumable.push(runId);
      }
    } catch {
      // corrupt checkpoint — skip
    }
  }
  return resumable;
}

/**
 * E1 / P0-2: one-time migration of checkpoints from legacy locations (where the
 * pre-fix code wrote/read — `process.cwd()/.autopilot/checkpoints`, typically
 * the gateway install dir) into the fixed root. Writes SYNCHRONOUSLY (not via
 * saveCheckpoint's async lock chain) so the dest files are on disk before
 * register()'s restore loop reads them — no race.
 *
 * Limitation: checkpoints scattered under past `state.workspace.root` dirs
 * cannot be auto-discovered without a workspace registry (form B, rejected).
 * Only the passed legacy roots are migrated; workspace-scattered checkpoints
 * are a documented manual move. Forward of this fix every new checkpoint lands
 * in the fixed root regardless of workspace, so this is a one-time legacy
 * concern. Returns the count migrated (for a startup log line).
 */
export function migrateLegacyCheckpoints(legacyRoots: readonly string[]): number {
  if (_checkpointingDisabledForTest) return 0;
  const destRoot = getCheckpointRoot();
  let migrated = 0;
  for (const legacy of legacyRoots) {
    if (!legacy) continue;
    // Compare CANONICAL checkpoint dirs (realpath), not string paths: on macOS
    // /var and /private/var differ as strings but resolve to the same dir, so a
    // string compare would wrongly treat the fixed root as a "legacy" location
    // and delete the checkpoint it just wrote.
    let legacyDir: string;
    let destDir: string;
    try {
      legacyDir = getCheckpointDir(legacy);
      destDir = getCheckpointDir(destRoot);
    } catch { continue; }
    if (legacyDir === destDir) continue; // already the fixed root
    let runIds: string[];
    try {
      runIds = listResumableCheckpoints(legacy);
    } catch {
      continue;
    }
    let rootMigrated = 0;
    for (const runId of runIds) {
      const state = loadCheckpoint(runId, legacy);
      if (!state) continue;
      // Sync dest write — must land before the restore loop reads the fixed root.
      let destOk = false;
      try {
        const cp = buildCheckpoint(state, runId, destRoot);
        atomicWriteFileSync(getCheckpointPath(destRoot, runId), JSON.stringify(cp));
        updateSessionIndex(destRoot, cp.sessionKey, runId);
        destOk = true;
      } catch (e) {
        _writeFailureCount++;
        try { console.error('[autopilot] checkpoint migration failed:', e); } catch { /* noop */ }
      }
      // Delete the legacy copy ONLY on successful dest write — a failed dest
      // write must not lose the run (leave it for a retry rather than orphan it).
      if (destOk) {
        try {
          const legacyPath = getCheckpointPath(legacy, runId);
          if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
        } catch { /* fail-silent */ }
        migrated++;
        rootMigrated++;
      }
    }
    // Drop the legacy session-index ONLY if runs actually moved from this root —
    // otherwise skipped (e.g. workspace-gone) runs keep their index entries
    // rather than being silently de-indexed.
    if (rootMigrated > 0) {
      try {
        const legacyIndex = getSessionIndexPath(legacy);
        if (fs.existsSync(legacyIndex)) fs.unlinkSync(legacyIndex);
      } catch { /* fail-silent */ }
    }
  }
  return migrated;
}

// Mirror of RESUMABLE_BLOCKED_REASONS from orchestrator.ts (kept local to avoid
// a circular import: orchestrator.ts imports nothing from this module, and we
// don't want to widen its dep surface). If the set in orchestrator.ts changes,
// update this too. (Documented linkage, not duplication-for-its-own-sake.)
const RESUMABLE_BLOCKED_LOCAL: ReadonlySet<string> = new Set([
  'stalled',
  'validation_failed',
  'evidence_missing',
  'injection_rejected',
  'no_progress', // E6 — keep in sync with orchestrator.ts RESUMABLE_BLOCKED_REASONS
]);
/** Exported for the parity test (keeps the mirror honest vs orchestrator.ts). */
export function isResumableBlockedReason(reason: string): boolean {
  return RESUMABLE_BLOCKED_LOCAL.has(reason);
}

/** Test-only: clear the write-lock map between tests. */
export function _clearWriteLocksForTest(): void {
  writeLocks.clear();
}

/**
 * Test-only: deterministically await all in-flight checkpoint writes. Reviewer
 * #2 Finding 5 fix — replaces the fragile "two setImmediate ticks" drain with
 * `Promise.all` over the lock map so tests don't flake if the lock chain grows
 * another async hop.
 */
export async function _flushAllWritesForTest(): Promise<void> {
  await Promise.all([...writeLocks.values()]);
}
