#!/usr/bin/env node
/** omm-state MCP server — exposes omm state read/write over stdio JSON-RPC. */
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile, } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
/* ── Cross-process O_EXCL lock (inlined per ADR-003 zero-dep + ADR-005) ── */
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
                if (code !== "EEXIST")
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
function assertSafeKey(key) {
    if (typeof key !== "string" || !KEY_PATTERN.test(key.trim())) {
        throw new Error("key must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)");
    }
}
function validateMcpStateWrite(key, value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, error: "value must be a JSON object" };
    }
    const now = new Date().toISOString();
    const next = { ...value, lastUpdatedAt: now };
    const mode = value.mode ?? key;
    const phaseMap = {
        ralph: RALPH_PHASES,
        autopilot: AUTOPILOT_PHASES,
        team: TEAM_PHASES,
    };
    const phases = phaseMap[mode];
    if (!phases)
        return { ok: true, state: next };
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
function stateRoot() {
    const env = process.env.OMM_STATE_ROOT;
    return typeof env === "string" && env.trim() !== ""
        ? env
        : join(homedir(), ".openclaw", "omm");
}
function stateDir() {
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
async function toolRead(key) {
    assertSafeKey(key);
    const filePath = join(stateDir(), `${key.trim()}.json`);
    return readFile(filePath, "utf8");
}
const WORKFLOW_MODES = new Set(["ralph", "autopilot", "team"]);
function detectWorkflowMode(key, value) {
    const mode = value.mode ?? key;
    return WORKFLOW_MODES.has(mode) ? mode : null;
}
function isLinkedPair(incomingMode, incoming, existingMode, existing) {
    if (incomingMode === "ralph" && existingMode === "team") {
        return existing.linked_ralph === true;
    }
    if (incomingMode === "team" && existingMode === "ralph") {
        return incoming.linked_ralph === true;
    }
    return false;
}
async function assertExclusivity(dir, incomingKey, incoming) {
    if (incoming.active !== true)
        return;
    const incomingMode = detectWorkflowMode(incomingKey, incoming);
    if (!incomingMode)
        return;
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const existingKey = entry.slice(0, -5);
        if (existingKey === incomingKey)
            continue;
        let parsed;
        try {
            const raw = await readFile(join(dir, entry), "utf8");
            parsed = JSON.parse(raw);
        }
        catch {
            continue;
        }
        const existingMode = detectWorkflowMode(existingKey, parsed);
        if (!existingMode)
            continue;
        if (parsed.active !== true)
            continue;
        if (isLinkedPair(incomingMode, incoming, existingMode, parsed))
            continue;
        throw new Error(`cannot activate ${incomingMode}: ${existingMode} is already active (only one workflow mode may be active at a time)`);
    }
}
async function toolWrite(key, value) {
    assertSafeKey(key);
    const safeKey = key.trim();
    const validation = validateMcpStateWrite(safeKey, value);
    if (!validation.ok) {
        throw new Error(validation.error);
    }
    const dir = stateDir();
    await mkdir(dir, { recursive: true });
    return withCrossProcessLock(dir, safeKey, async () => {
        await assertExclusivity(dir, safeKey, validation.state);
        const filePath = join(dir, `${safeKey}.json`);
        const tmpPath = `${filePath}.tmp`;
        const data = `${JSON.stringify(validation.state, null, 2)}\n`;
        await writeFile(tmpPath, data, "utf8");
        await rename(tmpPath, filePath);
        return `Written: ${filePath}`;
    });
}
async function toolList() {
    const dir = stateDir();
    try {
        const files = await readdir(dir);
        return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    }
    catch {
        return [];
    }
}
function respond(id, result) {
    const msg = { jsonrpc: "2.0", id, result };
    process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function respondError(id, code, message) {
    const msg = { jsonrpc: "2.0", id, error: { code, message } };
    process.stdout.write(`${JSON.stringify(msg)}\n`);
}
async function handleRequest(req) {
    const id = req.id ?? null;
    if (req.method === "initialize") {
        respond(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "omm-state", version: "0.3.0-alpha.1" },
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
        const params = req.params;
        const args = params.arguments ?? {};
        try {
            let content;
            if (params.name === "omm_state_read") {
                const key = args.key;
                content = await toolRead(key);
            }
            else if (params.name === "omm_state_write") {
                const key = args.key;
                const value = args.value;
                content = await toolWrite(key, value);
            }
            else if (params.name === "omm_state_list") {
                const keys = await toolList();
                content = JSON.stringify(keys);
            }
            else {
                respondError(id, -32601, `Unknown tool: ${params.name}`);
                return;
            }
            respond(id, { content: [{ type: "text", text: content }] });
        }
        catch (err) {
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