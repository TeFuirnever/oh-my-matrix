#!/usr/bin/env node
/** omm-memory MCP server — exposes a persistent JSON KV store over stdio JSON-RPC. */
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function assertSafeKey(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key.trim())) {
    throw new Error(
      "key must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (no path separators, dots, or reserved characters)",
    );
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
async function toolSet(key, value) {
  assertSafeKey(key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("value must be a JSON object");
  }
  const safeKey = key.trim();
  const dir = memoryDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${safeKey}.json`);
  const tmpPath = `${filePath}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmpPath, data, "utf8");
  await rename(tmpPath, filePath);
  return `Stored: ${filePath}`;
}
async function toolGet(key) {
  assertSafeKey(key);
  const filePath = join(memoryDir(), `${key.trim()}.json`);
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "null";
  }
}
async function toolDelete(key) {
  assertSafeKey(key);
  const filePath = join(memoryDir(), `${key.trim()}.json`);
  try {
    await unlink(filePath);
    return `Deleted: ${filePath}`;
  } catch {
    return `Not found: ${filePath}`;
  }
}
async function toolList() {
  const dir = memoryDir();
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
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
      serverInfo: { name: "omm-memory", version: "0.2.0" },
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
      if (params.name === "omm_memory_set") {
        const key = args.key;
        const value = args.value;
        content = await toolSet(key, value);
      } else if (params.name === "omm_memory_get") {
        const key = args.key;
        content = await toolGet(key);
      } else if (params.name === "omm_memory_delete") {
        const key = args.key;
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
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
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
//# sourceMappingURL=index.js.map
