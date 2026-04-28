#!/usr/bin/env node
/** omm-memory MCP server — exposes a persistent JSON KV store over stdio JSON-RPC. */
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile, } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
/* ── Inline error codes (ADR-003 zero-dep: do NOT import from omm-plugin) ── */
const OMM_E_KEY_INVALID = "OMM_E_KEY_INVALID";
const OMM_E_VALUE_MISSING = "OMM_E_VALUE_MISSING";
const OMM_E_VALUE_INVALID = "OMM_E_VALUE_INVALID";
const OMM_E_IO_FAILED = "OMM_E_IO_FAILED";
class OmmError extends Error {
    ommCode;
    hint;
    rpcCode;
    constructor(ommCode, message, hint, rpcCode = -32000) {
        super(message);
        this.ommCode = ommCode;
        this.hint = hint;
        this.rpcCode = rpcCode;
    }
}
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/* ── Per-key serialization queue (in-process) ── */
const writeQueues = new Map();
function withKeyLock(key, fn) {
    const tail = writeQueues.get(key) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    const tracker = next.catch(() => undefined);
    writeQueues.set(key, tracker);
    tracker.then(() => {
        if (writeQueues.get(key) === tracker)
            writeQueues.delete(key);
    });
    return next;
}
/* ── Cross-process O_EXCL lock (inlined per ADR-003 + ADR-005) ── */
const LOCK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const LOCK_DEFAULT_TIMEOUT_MS = 5000;
const LOCK_DEFAULT_STALE_MS = 30000;
const LOCK_POLL_BASE_MS = 50;
const LOCK_POLL_JITTER_MS = 20;
function lockSanitize(key) {
    if (LOCK_KEY_PATTERN.test(key))
        return key;
    return key.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64) || "_";
}
function lockSleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(1, ms)));
}
function lockJitterDelay() {
    return (LOCK_POLL_BASE_MS +
        Math.floor((Math.random() * 2 - 1) * LOCK_POLL_JITTER_MS));
}
function lockIsPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        const code = err?.code;
        if (code === "EPERM")
            return true;
        return false;
    }
}
async function lockReadMeta(path) {
    try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid === "number" &&
            typeof parsed.startedAt === "string" &&
            typeof parsed.hostname === "string") {
            return parsed;
        }
    }
    catch {
        /* malformed → no metadata */
    }
    return null;
}
async function withCrossProcessLock(lockDir, key, fn, options = {}) {
    const timeoutMs = options.timeoutMs ?? LOCK_DEFAULT_TIMEOUT_MS;
    const staleMs = options.staleMs ?? LOCK_DEFAULT_STALE_MS;
    const safeKey = lockSanitize(key);
    const locksRoot = join(lockDir, ".locks");
    const lockPath = join(locksRoot, `${safeKey}.lock`);
    return withKeyLock(`${lockDir}::${key}`, async () => {
        await mkdir(locksRoot, { recursive: true });
        const deadline = Date.now() + timeoutMs;
        const meta = {
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
                }
                finally {
                    await handle.close();
                }
                acquired = true;
                break;
            }
            catch (err) {
                const code = err?.code;
                if (code !== "EEXIST" && code !== "EPERM")
                    throw err;
                let isStale = false;
                try {
                    const st = await stat(lockPath);
                    const age = Date.now() - st.mtimeMs;
                    if (age >= staleMs) {
                        const existing = await lockReadMeta(lockPath);
                        if (existing == null ||
                            existing.hostname !== hostname() ||
                            !lockIsPidAlive(existing.pid)) {
                            isStale = true;
                        }
                    }
                }
                catch {
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
        }
        finally {
            await unlink(lockPath).catch(() => undefined);
        }
    });
}
function assertSafeKey(key) {
    if (typeof key !== "string" ||
        key.trim() === "" ||
        !KEY_PATTERN.test(key.trim())) {
        throw new OmmError(OMM_E_KEY_INVALID, "key must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)", "Provide a key using only alphanumerics, hyphens, and underscores");
    }
}
function memoryRoot() {
    const env = process.env.OMM_STATE_ROOT;
    return typeof env === "string" && env.trim() !== ""
        ? env.trim()
        : join(homedir(), ".openclaw", "omm");
}
function memoryDir() {
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
        description: "Read the JSON value at the given memory key. Returns null if absent.",
        inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
        },
    },
    {
        name: "omm_memory_delete",
        description: "Delete the memory key. Idempotent — does not error when absent.",
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
async function toolSet(key, value) {
    assertSafeKey(key);
    if (value === undefined) {
        throw new OmmError(OMM_E_VALUE_MISSING, "value is required", "Pass a plain object as `value`");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new OmmError(OMM_E_VALUE_INVALID, "value must be a JSON object", "Pass a plain object as `value` (not an array, primitive, or null)");
    }
    const safeKey = key.trim();
    const dir = memoryDir();
    try {
        await mkdir(dir, { recursive: true });
    }
    catch (err) {
        throw new OmmError(OMM_E_IO_FAILED, `failed to create memory directory: ${err.message}`);
    }
    return withCrossProcessLock(dir, safeKey, async () => {
        const filePath = join(dir, `${safeKey}.json`);
        const tmpPath = `${filePath}.tmp`;
        const data = `${JSON.stringify(value, null, 2)}\n`;
        try {
            await writeFile(tmpPath, data, "utf8");
            await rename(tmpPath, filePath);
        }
        catch (err) {
            throw new OmmError(OMM_E_IO_FAILED, `write failed: ${err.message}`);
        }
        return `Stored: ${filePath}`;
    });
}
async function toolDelete(key) {
    assertSafeKey(key);
    const safeKey = key.trim();
    const dir = memoryDir();
    try {
        await mkdir(dir, { recursive: true });
    }
    catch (err) {
        throw new OmmError(OMM_E_IO_FAILED, `failed to create memory directory: ${err.message}`, undefined, -32603);
    }
    return withCrossProcessLock(dir, safeKey, async () => {
        const filePath = join(dir, `${safeKey}.json`);
        try {
            await unlink(filePath);
            return `Deleted: ${filePath}`;
        }
        catch {
            return `Not found: ${filePath}`;
        }
    });
}
async function toolGet(key) {
    assertSafeKey(key);
    const filePath = join(memoryDir(), `${key.trim()}.json`);
    try {
        return await readFile(filePath, "utf8");
    }
    catch {
        return "null";
    }
}
async function toolList() {
    const dir = memoryDir();
    try {
        const files = await readdir(dir);
        return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    }
    catch {
        return [];
    }
}
function makeResponse(id, result) {
    return { jsonrpc: "2.0", id, result };
}
function makeErrorResponse(id, code, message, data) {
    const error = {
        code,
        message,
    };
    if (data !== undefined)
        error.data = data;
    return { jsonrpc: "2.0", id, error };
}
export async function processRequest(req) {
    const id = req.id ?? null;
    if (req.method === "initialize") {
        return makeResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "omm-memory", version: "0.3.0" },
        });
    }
    if (req.method === "notifications/initialized") {
        return makeResponse(id, null);
    }
    if (req.method === "tools/list") {
        return makeResponse(id, { tools: TOOLS });
    }
    if (req.method === "tools/call") {
        const params = req.params;
        const args = params.arguments ?? {};
        try {
            let content;
            if (params.name === "omm_memory_set") {
                content = await toolSet(args.key, args.value);
            }
            else if (params.name === "omm_memory_get") {
                content = await toolGet(args.key);
            }
            else if (params.name === "omm_memory_delete") {
                content = await toolDelete(args.key);
            }
            else if (params.name === "omm_memory_list") {
                const keys = await toolList();
                content = JSON.stringify(keys);
            }
            else {
                return makeErrorResponse(id, -32601, `Unknown tool: ${params.name}`);
            }
            return makeResponse(id, { content: [{ type: "text", text: content }] });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err instanceof OmmError) {
                const data = { code: err.ommCode };
                if (err.hint !== undefined)
                    data.hint = err.hint;
                return makeErrorResponse(id, err.rpcCode, message, data);
            }
            return makeErrorResponse(id, -32000, message);
        }
    }
    return makeErrorResponse(id, -32601, `Method not found: ${req.method}`);
}
async function handleRequest(req) {
    const response = await processRequest(req);
    process.stdout.write(`${JSON.stringify(response)}\n`);
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const MAX_REQUEST_BYTES = 1 << 20; // 1 MiB hard cap on a single JSON-RPC line
rl.on("line", (line) => {
    if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
        process.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
                code: -32600,
                message: `request exceeds ${MAX_REQUEST_BYTES}-byte limit`,
            },
        })}\n`);
        return;
    }
    const trimmed = line.trim();
    if (!trimmed)
        return;
    let req;
    try {
        req = JSON.parse(trimmed);
    }
    catch {
        process.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
        })}\n`);
        return;
    }
    handleRequest(req).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: { code: -32603, message },
        })}\n`);
    });
});
//# sourceMappingURL=index.js.map