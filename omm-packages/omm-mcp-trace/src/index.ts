#!/usr/bin/env node
/** omm-trace MCP server — append-only execution event log over stdio JSON-RPC. */
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

/* ── Inline error codes (ADR-003 zero-dep: do NOT import from omm-plugin)
 *
 * The cross-process lock, OmmError, JSON-RPC, and stdin reader code in this
 * file is duplicated across all 3 MCP servers (omm-mcp, omm-mcp-trace,
 * omm-mcp-memory). Any bug fix must be applied to all copies. See CONTEXT.md
 * "Known Trade-offs" for the rationale.
 * ── */

const OMM_E_KEY_INVALID = "OMM_E_KEY_INVALID";
const OMM_E_VALUE_INVALID = "OMM_E_VALUE_INVALID";
const OMM_E_IO_FAILED = "OMM_E_IO_FAILED";

class OmmError extends Error {
  constructor(
    readonly ommCode: string,
    message: string,
    readonly hint?: string,
    readonly rpcCode: number = -32000,
  ) {
    super(message);
  }
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/* ── Per-session serialization queue (in-process, zero-dep) ── */

const recordQueues = new Map<string, Promise<unknown>>();
function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = recordQueues.get(key) ?? Promise.resolve();
  const next = tail.then(fn, fn);
  const tracker: Promise<unknown> = next.catch(() => undefined);
  recordQueues.set(key, tracker);
  tracker.then(() => {
    if (recordQueues.get(key) === tracker) recordQueues.delete(key);
  });
  return next;
}

/* ── Cross-process O_EXCL lock (inlined per ADR-003 + ADR-005) ── */

const LOCK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const LOCK_DEFAULT_TIMEOUT_MS = 5000;
const LOCK_DEFAULT_STALE_MS = 30000;
const LOCK_POLL_BASE_MS = 50;
const LOCK_POLL_JITTER_MS = 20;

interface LockMeta {
  pid: number;
  startedAt: string;
  hostname: string;
}

function lockSanitize(key: string): string {
  if (LOCK_KEY_PATTERN.test(key)) return key;
  return key.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "_";
}

function lockSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(1, ms)));
}

function lockJitterDelay(): number {
  return (
    LOCK_POLL_BASE_MS +
    Math.floor((Math.random() * 2 - 1) * LOCK_POLL_JITTER_MS)
  );
}

function lockIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

async function lockReadMeta(path: string): Promise<LockMeta | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockMeta>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.hostname === "string"
    ) {
      return parsed as LockMeta;
    }
  } catch {
    /* malformed → no metadata */
  }
  return null;
}

async function withCrossProcessLock<T>(
  lockDir: string,
  key: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? LOCK_DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_DEFAULT_STALE_MS;
  const safeKey = lockSanitize(key);
  const locksRoot = join(lockDir, ".locks");
  const lockPath = join(locksRoot, `${safeKey}.lock`);

  return withKeyLock(`${lockDir}::${key}`, async () => {
    await mkdir(locksRoot, { recursive: true });
    const deadline = Date.now() + timeoutMs;
    const meta: LockMeta = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
    };
    const payload = `${JSON.stringify(meta)}\n`;
    let acquired = false;
    while (!acquired) {
      try {
        const handle = await open(lockPath, "wx", 0o644);
        try {
          await handle.writeFile(payload, "utf8");
        } finally {
          await handle.close();
        }
        acquired = true;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST" && code !== "EPERM") throw err;
        let isStale = false;
        try {
          const st = await stat(lockPath);
          const age = Date.now() - st.mtimeMs;
          if (age >= staleMs) {
            const existing = await lockReadMeta(lockPath);
            if (
              existing == null ||
              existing.hostname !== hostname() ||
              !lockIsPidAlive(existing.pid)
            ) {
              isStale = true;
            }
          }
        } catch {
          continue;
        }
        if (isStale) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`OMM_E_LOCK_TIMEOUT: ${key}`);
        }
        await lockSleep(lockJitterDelay());
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  });
}

/**
 * Rotation policy: when a session JSONL crosses TRACE_ROTATE_BYTES,
 * rename it to `${name}.${ms}` and start fresh. Archives accumulate
 * up to TRACE_MAX_ARCHIVES; older ones are pruned. Total per-session
 * disk = (TRACE_MAX_ARCHIVES + 1) * TRACE_ROTATE_BYTES bytes max.
 */
const TRACE_ROTATE_BYTES = 8 << 20;
const TRACE_MAX_ARCHIVES = 4;

function assertSafeKey(
  key: unknown,
  label = "session_id",
): asserts key is string {
  if (
    typeof key !== "string" ||
    key.trim() === "" ||
    !KEY_PATTERN.test(key.trim())
  ) {
    throw new OmmError(
      OMM_E_KEY_INVALID,
      `${label} must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)`,
      "Provide a session_id using only alphanumerics, hyphens, and underscores",
    );
  }
}

function traceRoot(): string {
  const env = process.env.OMM_STATE_ROOT;
  return typeof env === "string" && env.trim() !== ""
    ? env.trim()
    : join(homedir(), ".openclaw", "omm");
}

function traceDir(): string {
  return join(traceRoot(), "trace");
}

function tracePath(sessionId: string): string {
  return join(traceDir(), `${sessionId.trim()}.jsonl`);
}

/* ── MCP Resources (trace files exposed read-only via omm://trace/<sessionId>) ── */

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

const TRACE_URI_PATTERN = /^omm:\/\/trace\/([a-z0-9_-]+)$/i;
const TRACE_MIME = "application/x-jsonlines";

async function listTraceResources(): Promise<McpResource[]> {
  try {
    const files = await readdir(traceDir());
    return files
      .filter((f) => f.endsWith(".jsonl") && !f.startsWith("."))
      .map((f) => f.slice(0, -6))
      .filter((sessionId) => KEY_PATTERN.test(sessionId))
      .sort()
      .map((sessionId) => ({
        uri: `omm://trace/${sessionId}`,
        name: `omm trace: ${sessionId}`,
        description: `Trace events for session ${sessionId}`,
        mimeType: TRACE_MIME,
      }));
  } catch {
    return [];
  }
}

async function readTraceResource(uri: string): Promise<McpResourceContents> {
  const match = TRACE_URI_PATTERN.exec(uri);
  if (!match) {
    throw new OmmError(
      OMM_E_KEY_INVALID,
      `unsupported resource URI: ${uri}`,
      "URI must match omm://trace/<sessionId>",
    );
  }
  const sessionId = match[1];
  assertSafeKey(sessionId);
  const text = await readFile(tracePath(sessionId), "utf8");
  return { uri, mimeType: TRACE_MIME, text };
}

interface TraceEvent {
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

function validateEvent(value: unknown): TraceEvent | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "event must be a JSON object";
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.timestamp !== "string" ||
    !Number.isFinite(Date.parse(v.timestamp))
  ) {
    return "event.timestamp must be a valid ISO8601 string";
  }
  if (typeof v.type !== "string" || v.type.trim() === "") {
    return "event.type must be a non-empty string";
  }
  return v as TraceEvent;
}

const TOOLS = [
  {
    name: "omm_trace_record",
    description:
      "Append a trace event to the session log. Event must include `timestamp` (ISO8601) and `type` fields.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        event: { type: "object" },
      },
      required: ["session_id", "event"],
    },
  },
  {
    name: "omm_trace_query",
    description:
      "Read trace events for a session. Optional `since` and `until` ISO8601 timestamps filter inclusively.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "omm_trace_list_sessions",
    description: "List session IDs that have a trace log.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "omm_trace_metrics",
    description:
      "Compute latency percentiles and error rate for tool_call events in a session. Optional sinceMs limits to the last N milliseconds.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        sinceMs: { type: "number" },
      },
      required: ["sessionId"],
    },
  },
];

async function toolRecord(sessionId: unknown, event: unknown): Promise<string> {
  assertSafeKey(sessionId);
  const validated = validateEvent(event);
  if (typeof validated === "string") {
    throw new OmmError(
      OMM_E_VALUE_INVALID,
      validated,
      "Provide an event object with `timestamp` (ISO8601) and `type` (non-empty string) fields",
    );
  }
  const dir = traceDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new OmmError(
      OMM_E_IO_FAILED,
      `failed to create trace directory: ${(err as Error).message}`,
    );
  }
  const path = tracePath(sessionId);
  // Serialize per-session so rotateIfNeeded → appendFile is atomic against
  // concurrent records that would otherwise race on the rotation rename.
  return withCrossProcessLock(dir, `record::${sessionId.trim()}`, async () => {
    try {
      await rotateIfNeeded(path);
      await appendFile(path, `${JSON.stringify(validated)}\n`, "utf8");
    } catch (err) {
      if (err instanceof OmmError) throw err;
      throw new OmmError(
        OMM_E_IO_FAILED,
        `append failed: ${(err as Error).message}`,
      );
    }
    return `Recorded: ${path}`;
  });
}

/** Rename `path` to `path.${ms}` and prune archives if it has grown past the rotate threshold. */
async function rotateIfNeeded(path: string): Promise<void> {
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return; // not yet created — nothing to rotate
  }
  if (size < TRACE_ROTATE_BYTES) return;
  const archive = `${path}.${Date.now()}`;
  await rename(path, archive);
  await pruneArchives(path);
}

async function pruneArchives(currentPath: string): Promise<void> {
  const dir = dirname(currentPath);
  const prefix = `${basename(currentPath)}.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const archives = entries
    .filter((f) => f.startsWith(prefix))
    .sort()
    .reverse(); // newest first by timestamp suffix
  for (const stale of archives.slice(TRACE_MAX_ARCHIVES)) {
    await unlink(join(dir, stale)).catch(() => undefined);
  }
}

/** Return all session-log files (archives + current) ordered oldest → newest. */
async function listSessionFiles(sessionId: string): Promise<string[]> {
  const dir = traceDir();
  const current = tracePath(sessionId);
  const baseName = basename(current);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const archives = entries
    .filter((f) => f.startsWith(`${baseName}.`))
    .sort() // ascending by ms timestamp suffix
    .map((f) => join(dir, f));
  if (entries.includes(baseName)) archives.push(current);
  return archives;
}

async function toolQuery(
  sessionId: unknown,
  since?: string,
  until?: string,
): Promise<TraceEvent[]> {
  assertSafeKey(sessionId);
  if (since !== undefined && !Number.isFinite(Date.parse(since))) {
    throw new Error("since must be a valid ISO8601 timestamp when provided");
  }
  if (until !== undefined && !Number.isFinite(Date.parse(until))) {
    throw new Error("until must be a valid ISO8601 timestamp when provided");
  }
  const sinceMs =
    since !== undefined ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  const untilMs =
    until !== undefined ? Date.parse(until) : Number.POSITIVE_INFINITY;

  const files = await listSessionFiles(sessionId);
  const events: TraceEvent[] = [];
  for (const path of files) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const validated = validateEvent(parsed);
      if (typeof validated === "string") continue;
      const ts = Date.parse(validated.timestamp);
      if (ts < sinceMs || ts > untilMs) continue;
      events.push(validated);
    }
  }
  return events;
}

async function toolListSessions(): Promise<string[]> {
  const dir = traceDir();
  try {
    const files = await readdir(dir);
    const ids = new Set<string>();
    for (const f of files) {
      // Match `${id}.jsonl` (current) or `${id}.jsonl.${ms}` (archive).
      const m = f.match(/^([a-z0-9][a-z0-9_-]{0,63})\.jsonl(?:\.\d+)?$/i);
      if (m) ids.add(m[1]);
    }
    return Array.from(ids).sort();
  } catch {
    return [];
  }
}

interface MetricRecord {
  durationMs: number;
  toolName: string;
  ok: boolean;
}

interface ToolMetrics {
  count: number;
  errorRate: number;
  p50: number;
  p99: number;
}

interface MetricsResult extends ToolMetrics {
  byTool: Record<string, ToolMetrics>;
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * pct)] ?? sorted[sorted.length - 1];
}

function aggregateMetrics(records: MetricRecord[]): ToolMetrics {
  if (records.length === 0) return { count: 0, errorRate: 0, p50: 0, p99: 0 };
  const sorted = records.map((r) => r.durationMs).sort((a, b) => a - b);
  const errors = records.filter((r) => !r.ok).length;
  return {
    count: records.length,
    errorRate: errors / records.length,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
  };
}

async function toolMetrics(
  sessionId: string | undefined,
  sinceMs: number | undefined,
): Promise<MetricsResult> {
  const cutoff =
    sinceMs !== undefined ? Date.now() - sinceMs : Number.NEGATIVE_INFINITY;

  let sessionIds: string[];
  if (sessionId !== undefined) {
    assertSafeKey(sessionId, "sessionId");
    sessionIds = [sessionId];
  } else {
    sessionIds = await toolListSessions();
  }

  const metricRecords: MetricRecord[] = [];

  for (const sid of sessionIds) {
    const files = await listSessionFiles(sid);
    for (const path of files) {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const validated = validateEvent(parsed);
        if (typeof validated === "string") continue;
        const ts = Date.parse(validated.timestamp);
        if (ts < cutoff) continue;
        const { durationMs, toolName, ok } = validated as Record<
          string,
          unknown
        >;
        if (
          typeof durationMs !== "number" ||
          typeof toolName !== "string" ||
          typeof ok !== "boolean"
        ) {
          continue;
        }
        metricRecords.push({ durationMs, toolName, ok });
      }
    }
  }

  const overall = aggregateMetrics(metricRecords);

  const byToolMap = new Map<string, MetricRecord[]>();
  for (const rec of metricRecords) {
    const bucket = byToolMap.get(rec.toolName) ?? [];
    bucket.push(rec);
    byToolMap.set(rec.toolName, bucket);
  }

  const byTool: Record<string, ToolMetrics> = {};
  for (const [name, recs] of byToolMap) {
    byTool[name] = aggregateMetrics(recs);
  }

  return { ...overall, byTool };
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function makeResponse(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: { code: number; message: string; data?: unknown } = {
    code,
    message,
  };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export async function processRequest(
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  if (req.method === "initialize") {
    return makeResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "omm-trace", version: "0.4.0" },
    });
  }

  if (req.method === "notifications/initialized") {
    return makeResponse(id, null);
  }

  if (req.method === "tools/list") {
    return makeResponse(id, { tools: TOOLS });
  }

  if (req.method === "resources/list") {
    const resources = await listTraceResources();
    return makeResponse(id, { resources });
  }

  if (req.method === "resources/read") {
    const params = req.params as { uri?: unknown } | undefined;
    if (typeof params?.uri !== "string") {
      return makeErrorResponse(id, -32602, "resources/read: uri required");
    }
    try {
      const contents = await readTraceResource(params.uri);
      return makeResponse(id, { contents: [contents] });
    } catch (err) {
      if (err instanceof OmmError) {
        const data: { code: string; hint?: string } = { code: err.ommCode };
        if (err.hint !== undefined) data.hint = err.hint;
        return makeErrorResponse(id, err.rpcCode, err.message, data);
      }
      return makeErrorResponse(id, -32000, (err as Error).message);
    }
  }

  if (req.method === "tools/call") {
    const params = req.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    const args = params.arguments ?? {};

    try {
      let content: string;
      if (params.name === "omm_trace_record") {
        content = await toolRecord(args.session_id, args.event);
      } else if (params.name === "omm_trace_query") {
        const since = args.since as string | undefined;
        const until = args.until as string | undefined;
        const events = await toolQuery(args.session_id, since, until);
        content = JSON.stringify(events);
      } else if (params.name === "omm_trace_list_sessions") {
        const sessions = await toolListSessions();
        content = JSON.stringify(sessions);
      } else if (params.name === "omm_trace_metrics") {
        const sessionId = args.sessionId as string | undefined;
        const sinceMs = args.sinceMs as number | undefined;
        const metrics = await toolMetrics(sessionId, sinceMs);
        content = JSON.stringify(metrics);
      } else {
        return makeErrorResponse(id, -32601, `Unknown tool: ${params.name}`);
      }
      return makeResponse(id, { content: [{ type: "text", text: content }] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof OmmError) {
        const data: { code: string; hint?: string } = { code: err.ommCode };
        if (err.hint !== undefined) data.hint = err.hint;
        return makeErrorResponse(id, err.rpcCode, message, data);
      }
      return makeErrorResponse(id, -32000, message);
    }
  }

  return makeErrorResponse(id, -32601, `Method not found: ${req.method}`);
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const response = await processRequest(req);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

const MAX_REQUEST_BYTES = 1 << 20; // 1 MiB hard cap on a single JSON-RPC line

rl.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: `request exceeds ${MAX_REQUEST_BYTES}-byte limit`,
        },
      })}\n`,
    );
    return;
  }
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      })}\n`,
    );
    return;
  }
  handleRequest(req).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32603, message },
      })}\n`,
    );
  });
});
