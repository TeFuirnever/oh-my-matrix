#!/usr/bin/env node
/** omm-state MCP server — exposes omm state read/write over stdio JSON-RPC. */
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/* ── Inline error codes (ADR-003 zero-dep: do NOT import from omm-plugin) ── */

const OMM_E_KEY_MISSING = "OMM_E_KEY_MISSING";
const OMM_E_KEY_INVALID = "OMM_E_KEY_INVALID";
const OMM_E_VALUE_MISSING = "OMM_E_VALUE_MISSING";
const OMM_E_VALUE_INVALID = "OMM_E_VALUE_INVALID";
const OMM_E_STATE_INVALID = "OMM_E_STATE_INVALID";
const OMM_E_WORKFLOW_CONFLICT = "OMM_E_WORKFLOW_CONFLICT";

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

/* ── Per-key serialization queue (in-process) ── */

const writeQueues = new Map<string, Promise<unknown>>();
function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = writeQueues.get(key) ?? Promise.resolve();
  const next = tail.then(fn, fn);
  const tracker: Promise<unknown> = next.catch(() => undefined);
  writeQueues.set(key, tracker);
  tracker.then(() => {
    if (writeQueues.get(key) === tracker) writeQueues.delete(key);
  });
  return next;
}

/* ── Cross-process O_EXCL lock (inlined per ADR-003 zero-dep + ADR-005) ── */

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

/* ── Inline validation (mirrors omm-plugin/src/omm-state-validation.ts)
 *
 * This is a SUBSET of the plugin validation: it checks phase values and
 * terminal-phase/active consistency, but does NOT inject counter defaults
 * (iteration, max_iterations, etc.) or validate ISO timestamps. Callers
 * needing full validation should use the mode lifecycle API via the plugin,
 * not the raw MCP state_write tool. See CONTEXT.md "Known Trade-offs".
 * ── */

const RALPH_PHASES = new Set([
  "init",
  "planning",
  "executing",
  "verifying",
  "fixing",
  "complete",
  "failed",
]);
const AUTOPILOT_PHASES = new Set([
  "analyzing",
  "planning",
  "executing",
  "verifying",
  "retry",
  "complete",
  "blocked",
  "failed",
]);
const TEAM_PHASES = new Set([
  "planning",
  "decomposing",
  "executing",
  "verifying",
  "fixing",
  "delegating",
  "complete",
  "failed",
]);
const TERMINAL = new Set(["complete", "failed", "blocked"]);

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function assertSafeKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new OmmError(
      OMM_E_KEY_MISSING,
      "key is required",
      "Provide a non-empty key matching [a-z0-9][a-z0-9_-]{0,63}",
    );
  }
  if (!KEY_PATTERN.test(key.trim())) {
    throw new OmmError(
      OMM_E_KEY_INVALID,
      "key must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)",
      "Provide a key using only alphanumerics, hyphens, and underscores",
    );
  }
}

function validateMcpStateWrite(
  key: string,
  value: Record<string, unknown>,
): { ok: boolean; state?: Record<string, unknown>; error?: string } {
  const now = new Date().toISOString();
  const next: Record<string, unknown> = { ...value, lastUpdatedAt: now };
  const mode = (value.mode as string | undefined) ?? key;

  const phaseMap: Record<string, Set<string>> = {
    ralph: RALPH_PHASES,
    autopilot: AUTOPILOT_PHASES,
    team: TEAM_PHASES,
  };
  const phases = phaseMap[mode];
  if (!phases) return { ok: true, state: next };

  const statusField = mode === "team" ? "current_phase" : "status";
  const raw = next[statusField];
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (!phases.has(normalized))
      return {
        ok: false,
        error: `${mode}.${statusField} must be one of: ${[...phases].join(", ")}`,
      };
    next[statusField] = normalized;
    if (TERMINAL.has(normalized) && next.active === true) {
      return { ok: false, error: "terminal status requires active=false" };
    }
  }

  return { ok: true, state: next };
}

function stateRoot(): string {
  const env = process.env.OMM_STATE_ROOT;
  return typeof env === "string" && env.trim() !== ""
    ? env
    : join(homedir(), ".openclaw", "omm");
}

function stateDir(): string {
  return join(stateRoot(), "state");
}

/* ── MCP Resources (state files exposed read-only via omm://state/<key>) ── */

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

const STATE_URI_PATTERN = /^omm:\/\/state\/([a-z0-9_-]+)$/i;

async function listStateResources(): Promise<McpResource[]> {
  try {
    const files = await readdir(stateDir());
    return files
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => f.slice(0, -5))
      .filter((key) => KEY_PATTERN.test(key))
      .sort()
      .map((key) => ({
        uri: `omm://state/${key}`,
        name: `omm state: ${key}`,
        description: `Persisted ${key} state JSON`,
        mimeType: "application/json",
      }));
  } catch {
    return [];
  }
}

async function readStateResource(uri: string): Promise<McpResourceContents> {
  const match = STATE_URI_PATTERN.exec(uri);
  if (!match) {
    throw new OmmError(
      OMM_E_KEY_INVALID,
      `unsupported resource URI: ${uri}`,
      "URI must match omm://state/<key>",
    );
  }
  const key = match[1];
  assertSafeKey(key);
  const filePath = join(stateDir(), `${key}.json`);
  const text = await readFile(filePath, "utf8");
  return { uri, mimeType: "application/json", text };
}

/* ── MCP Prompts (agent-prompts/<name>.md exposed read-only) ──
 *
 * Path resolution mirrors omm-plugin/src/omm-agent-prompts.ts:26-31. From
 * the compiled dist/src/index.js, traverse up to the package root and over
 * to omm-skills/agent-prompts/. Returns [] if the directory is missing so
 * a deployment gap surfaces as empty prompts/list rather than a hard fail.
 * ── */

const PROMPT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

interface McpPrompt {
  name: string;
  description?: string;
}

interface McpPromptMessage {
  role: "user" | "assistant" | "system";
  content: { type: "text"; text: string };
}

function agentPromptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "omm-skills", "agent-prompts");
}

async function listAgentPromptsForMcp(): Promise<McpPrompt[]> {
  try {
    const files = await readdir(agentPromptsDir());
    return files
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .map((f) => f.slice(0, -3))
      .filter((name) => PROMPT_NAME_PATTERN.test(name))
      .sort()
      .map((name) => ({ name, description: `omm agent prompt: ${name}` }));
  } catch {
    return [];
  }
}

async function getAgentPromptForMcp(name: unknown): Promise<{
  description: string;
  messages: McpPromptMessage[];
}> {
  if (typeof name !== "string" || !PROMPT_NAME_PATTERN.test(name)) {
    throw new OmmError(
      OMM_E_KEY_INVALID,
      `invalid prompt name: ${typeof name === "string" ? name : "(missing)"}`,
      "Name must match /^[a-z][a-z0-9-]*$/",
    );
  }
  const filePath = join(agentPromptsDir(), `${name}.md`);
  const text = await readFile(filePath, "utf8");
  return {
    description: `omm agent prompt: ${name}`,
    messages: [{ role: "system", content: { type: "text", text } }],
  };
}

const TOOLS = [
  {
    name: "omm_state_read",
    description: "Read a JSON state file by key",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "omm_state_write",
    description: "Write a JSON value to a state file by key",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "object" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "omm_state_list",
    description: "List all state keys",
    inputSchema: { type: "object", properties: {} },
  },
];

async function toolRead(key: unknown): Promise<string> {
  assertSafeKey(key);
  const filePath = join(stateDir(), `${key.trim()}.json`);
  return readFile(filePath, "utf8");
}

const WORKFLOW_MODES = new Set(["ralph", "autopilot", "team"]);

function detectWorkflowMode(
  key: string,
  value: Record<string, unknown>,
): string | null {
  const mode = (value.mode as string | undefined) ?? key;
  return WORKFLOW_MODES.has(mode) ? mode : null;
}

function isLinkedPair(
  incomingMode: string,
  incoming: Record<string, unknown>,
  existingMode: string,
  existing: Record<string, unknown>,
): boolean {
  if (incomingMode === "ralph" && existingMode === "team") {
    return existing.linked_ralph === true;
  }
  if (incomingMode === "team" && existingMode === "ralph") {
    return incoming.linked_ralph === true;
  }
  return false;
}

async function assertExclusivity(
  dir: string,
  incomingKey: string,
  incoming: Record<string, unknown>,
): Promise<void> {
  if (incoming.active !== true) return;
  const incomingMode = detectWorkflowMode(incomingKey, incoming);
  if (!incomingMode) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const existingKey = entry.slice(0, -5);
    if (existingKey === incomingKey) continue;
    let parsed: Record<string, unknown>;
    try {
      const raw = await readFile(join(dir, entry), "utf8");
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const existingMode = detectWorkflowMode(existingKey, parsed);
    if (!existingMode) continue;
    if (parsed.active !== true) continue;
    if (isLinkedPair(incomingMode, incoming, existingMode, parsed)) continue;
    throw new OmmError(
      OMM_E_WORKFLOW_CONFLICT,
      `cannot activate ${incomingMode}: ${existingMode} is already active (only one workflow mode may be active at a time)`,
      `Cancel the active workflow first (current: ${existingMode})`,
      -32000,
    );
  }
}

async function toolWrite(key: unknown, value: unknown): Promise<string> {
  assertSafeKey(key);
  const safeKey = key.trim();

  if (value === undefined || value === null) {
    throw new OmmError(
      OMM_E_VALUE_MISSING,
      "value is required",
      "Pass a plain object as `value`",
    );
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new OmmError(
      OMM_E_VALUE_INVALID,
      "value must be a JSON object",
      "Pass a plain object as `value` (not an array, primitive, or null)",
    );
  }

  const validation = validateMcpStateWrite(
    safeKey,
    value as Record<string, unknown>,
  );
  if (!validation.ok) {
    throw new OmmError(
      OMM_E_STATE_INVALID,
      validation.error ?? "state validation failed",
    );
  }

  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  return withCrossProcessLock(dir, safeKey, async () => {
    await assertExclusivity(
      dir,
      safeKey,
      validation.state as Record<string, unknown>,
    );
    const filePath = join(dir, `${safeKey}.json`);
    const tmpPath = `${filePath}.tmp`;
    const data = `${JSON.stringify(validation.state, null, 2)}\n`;
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, filePath);
    return `Written: ${filePath}`;
  });
}

async function toolList(): Promise<string[]> {
  const dir = stateDir();
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
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

function respond(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify(makeResponse(id, result))}\n`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
void respond; // used in legacy paths below

export async function processRequest(
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  if (req.method === "initialize") {
    return makeResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "omm-state", version: "0.4.2" },
    });
  }

  if (req.method === "notifications/initialized") {
    return makeResponse(id, null);
  }

  if (req.method === "tools/list") {
    return makeResponse(id, { tools: TOOLS });
  }

  if (req.method === "resources/list") {
    const resources = await listStateResources();
    return makeResponse(id, { resources });
  }

  if (req.method === "resources/read") {
    const params = req.params as { uri?: unknown } | undefined;
    if (typeof params?.uri !== "string") {
      return makeErrorResponse(id, -32602, "resources/read: uri required");
    }
    try {
      const contents = await readStateResource(params.uri);
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

  if (req.method === "prompts/list") {
    const prompts = await listAgentPromptsForMcp();
    return makeResponse(id, { prompts });
  }

  if (req.method === "prompts/get") {
    const params = req.params as { name?: unknown } | undefined;
    try {
      const result = await getAgentPromptForMcp(params?.name);
      return makeResponse(id, result);
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
      if (params.name === "omm_state_read") {
        content = await toolRead(args.key);
      } else if (params.name === "omm_state_write") {
        content = await toolWrite(args.key, args.value);
      } else if (params.name === "omm_state_list") {
        const keys = await toolList();
        content = JSON.stringify(keys);
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
