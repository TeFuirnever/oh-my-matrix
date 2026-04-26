#!/usr/bin/env node
/** omm-state MCP server — exposes omm state read/write over stdio JSON-RPC. */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/* ── Per-key serialization queue (in-process; cross-process is single-user only) ── */

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

/* ── Inline validation (mirrors omm-plugin/src/omm-state-validation.ts) ── */

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

function assertSafeKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key.trim())) {
    throw new Error(
      "key must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)",
    );
  }
}

function validateMcpStateWrite(
  key: string,
  value: Record<string, unknown>,
): { ok: boolean; state?: Record<string, unknown>; error?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "value must be a JSON object" };
  }
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

async function toolRead(key: string): Promise<string> {
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
    throw new Error(
      `cannot activate ${incomingMode}: ${existingMode} is already active (only one workflow mode may be active at a time)`,
    );
  }
}

async function toolWrite(key: string, value: object): Promise<string> {
  assertSafeKey(key);
  const safeKey = key.trim();
  const validation = validateMcpStateWrite(
    safeKey,
    value as Record<string, unknown>,
  );
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  return withKeyLock(`${dir}::${safeKey}`, async () => {
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
  error?: { code: number; message: string };
};

function respond(id: string | number | null, result: unknown): void {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respondError(
  id: string | number | null,
  code: number,
  message: string,
): void {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;

  if (req.method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "omm-state", version: "0.2.1" },
    });
    return;
  }

  if (req.method === "notifications/initialized") {
    return;
  }

  if (req.method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
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
        const key = args.key as string;
        content = await toolRead(key);
      } else if (params.name === "omm_state_write") {
        const key = args.key as string;
        const value = args.value as object;
        content = await toolWrite(key, value);
      } else if (params.name === "omm_state_list") {
        const keys = await toolList();
        content = JSON.stringify(keys);
      } else {
        respondError(id, -32601, `Unknown tool: ${params.name}`);
        return;
      }
      respond(id, { content: [{ type: "text", text: content }] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respondError(id, -32000, message);
    }
    return;
  }

  respondError(id, -32601, `Method not found: ${req.method}`);
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
