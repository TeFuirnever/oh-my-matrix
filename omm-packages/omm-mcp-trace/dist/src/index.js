#!/usr/bin/env node
/** omm-trace MCP server — append-only execution event log over stdio JSON-RPC. */
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/**
 * Rotation policy: when a session JSONL crosses TRACE_ROTATE_BYTES,
 * rename it to `${name}.${ms}` and start fresh. Archives accumulate
 * up to TRACE_MAX_ARCHIVES; older ones are pruned. Total per-session
 * disk = (TRACE_MAX_ARCHIVES + 1) * TRACE_ROTATE_BYTES bytes max.
 */
const TRACE_ROTATE_BYTES = 8 << 20;
const TRACE_MAX_ARCHIVES = 4;
function assertSafeKey(key, label = "session_id") {
    if (typeof key !== "string" || !KEY_PATTERN.test(key.trim())) {
        throw new Error(`${label} must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)`);
    }
}
function traceRoot() {
    const env = process.env.OMM_STATE_ROOT;
    return typeof env === "string" && env.trim() !== ""
        ? env.trim()
        : join(homedir(), ".openclaw", "omm");
}
function traceDir() {
    return join(traceRoot(), "trace");
}
function tracePath(sessionId) {
    return join(traceDir(), `${sessionId.trim()}.jsonl`);
}
function validateEvent(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "event must be a JSON object";
    }
    const v = value;
    if (typeof v.timestamp !== "string" ||
        !Number.isFinite(Date.parse(v.timestamp))) {
        return "event.timestamp must be a valid ISO8601 string";
    }
    if (typeof v.type !== "string" || v.type.trim() === "") {
        return "event.type must be a non-empty string";
    }
    return v;
}
const TOOLS = [
    {
        name: "omm_trace_record",
        description: "Append a trace event to the session log. Event must include `timestamp` (ISO8601) and `type` fields.",
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
        description: "Read trace events for a session. Optional `since` and `until` ISO8601 timestamps filter inclusively.",
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
];
async function toolRecord(sessionId, event) {
    assertSafeKey(sessionId);
    const validated = validateEvent(event);
    if (typeof validated === "string") {
        throw new Error(validated);
    }
    const dir = traceDir();
    await mkdir(dir, { recursive: true });
    const path = tracePath(sessionId);
    await rotateIfNeeded(path);
    await appendFile(path, `${JSON.stringify(validated)}\n`, "utf8");
    return `Recorded: ${path}`;
}
/** Rename `path` to `path.${ms}` and prune archives if it has grown past the rotate threshold. */
async function rotateIfNeeded(path) {
    let size = 0;
    try {
        size = (await stat(path)).size;
    }
    catch {
        return; // not yet created — nothing to rotate
    }
    if (size < TRACE_ROTATE_BYTES)
        return;
    const archive = `${path}.${Date.now()}`;
    await rename(path, archive);
    await pruneArchives(path);
}
async function pruneArchives(currentPath) {
    const dir = dirname(currentPath);
    const prefix = `${basename(currentPath)}.`;
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
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
async function listSessionFiles(sessionId) {
    const dir = traceDir();
    const current = tracePath(sessionId);
    const baseName = basename(current);
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return [];
    }
    const archives = entries
        .filter((f) => f.startsWith(`${baseName}.`))
        .sort() // ascending by ms timestamp suffix
        .map((f) => join(dir, f));
    if (entries.includes(baseName))
        archives.push(current);
    return archives;
}
async function toolQuery(sessionId, since, until) {
    assertSafeKey(sessionId);
    if (since !== undefined && !Number.isFinite(Date.parse(since))) {
        throw new Error("since must be a valid ISO8601 timestamp when provided");
    }
    if (until !== undefined && !Number.isFinite(Date.parse(until))) {
        throw new Error("until must be a valid ISO8601 timestamp when provided");
    }
    const sinceMs = since !== undefined ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    const untilMs = until !== undefined ? Date.parse(until) : Number.POSITIVE_INFINITY;
    const files = await listSessionFiles(sessionId);
    const events = [];
    for (const path of files) {
        let raw;
        try {
            raw = await readFile(path, "utf8");
        }
        catch {
            continue;
        }
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "")
                continue;
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            const validated = validateEvent(parsed);
            if (typeof validated === "string")
                continue;
            const ts = Date.parse(validated.timestamp);
            if (ts < sinceMs || ts > untilMs)
                continue;
            events.push(validated);
        }
    }
    return events;
}
async function toolListSessions() {
    const dir = traceDir();
    try {
        const files = await readdir(dir);
        const ids = new Set();
        for (const f of files) {
            // Match `${id}.jsonl` (current) or `${id}.jsonl.${ms}` (archive).
            const m = f.match(/^([a-z0-9][a-z0-9_-]{0,63})\.jsonl(?:\.\d+)?$/i);
            if (m)
                ids.add(m[1]);
        }
        return Array.from(ids).sort();
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
            serverInfo: { name: "omm-trace", version: "0.2.0" },
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
            if (params.name === "omm_trace_record") {
                const sessionId = args.session_id;
                const event = args.event;
                content = await toolRecord(sessionId, event);
            }
            else if (params.name === "omm_trace_query") {
                const sessionId = args.session_id;
                const since = args.since;
                const until = args.until;
                const events = await toolQuery(sessionId, since, until);
                content = JSON.stringify(events);
            }
            else if (params.name === "omm_trace_list_sessions") {
                const sessions = await toolListSessions();
                content = JSON.stringify(sessions);
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