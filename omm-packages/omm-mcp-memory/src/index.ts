#!/usr/bin/env node
/** omm-memory MCP server — exposes a persistent JSON KV store over stdio JSON-RPC. */
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
import { join } from "node:path";
import { createInterface } from "node:readline";

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

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
        if (code !== "EEXIST") throw err;
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

function assertSafeKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key.trim())) {
    throw new Error(
      "key must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)",
    );
  }
}

function memoryRoot(): string {
  const env = process.env.OMM_STATE_ROOT;
  return typeof env === "string" && env.trim() !== ""
    ? env.trim()
    : join(homedir(), ".openclaw", "omm");
}

function memoryDir(): string {
  return join(memoryRoot(), "memory");
}

const TOOLS = [
  {
    name: "omm_memory_set",
    description: "Persist a JSON object value under the given memory key.",
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
    name: "omm_memory_get",
    description:
      "Read the JSON value at the given memory key. Returns null if absent.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "omm_memory_delete",
    description:
      "Delete the memory key. Idempotent — does not error when absent.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "omm_memory_list",
    description: "List all memory keys.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function toolSet(key: string, value: object): Promise<string> {
  assertSafeKey(key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("value must be a JSON object");
  }
  const safeKey = key.trim();
  const dir = memoryDir();
  await mkdir(dir, { recursive: true });
  return withCrossProcessLock(dir, safeKey, async () => {
    const filePath = join(dir, `${safeKey}.json`);
    const tmpPath = `${filePath}.tmp`;
    const data = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, filePath);
    return `Stored: ${filePath}`;
  });
}

async function toolDelete(key: string): Promise<string> {
  assertSafeKey(key);
  const safeKey = key.trim();
  const dir = memoryDir();
  await mkdir(dir, { recursive: true });
  return withCrossProcessLock(dir, safeKey, async () => {
    const filePath = join(dir, `${safeKey}.json`);
    try {
      await unlink(filePath);
      return `Deleted: ${filePath}`;
    } catch {
      return `Not found: ${filePath}`;
    }
  });
}

async function toolGet(key: string): Promise<string> {
  assertSafeKey(key);
  const filePath = join(memoryDir(), `${key.trim()}.json`);
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "null";
  }
}

async function toolList(): Promise<string[]> {
  const dir = memoryDir();
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
      serverInfo: { name: "omm-memory", version: "0.3.0-alpha.1" },
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
      if (params.name === "omm_memory_set") {
        const key = args.key as string;
        const value = args.value as object;
        content = await toolSet(key, value);
      } else if (params.name === "omm_memory_get") {
        const key = args.key as string;
        content = await toolGet(key);
      } else if (params.name === "omm_memory_delete") {
        const key = args.key as string;
        content = await toolDelete(key);
      } else if (params.name === "omm_memory_list") {
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
