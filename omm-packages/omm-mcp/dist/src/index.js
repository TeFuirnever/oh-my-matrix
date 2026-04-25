#!/usr/bin/env node
/** omm-state MCP server — exposes omm state read/write over stdio JSON-RPC. */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
  const filePath = join(stateDir(), `${key}.json`);
  return readFile(filePath, "utf8");
}
async function toolWrite(key, value) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${key}.json`);
  const tmpPath = `${filePath}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmpPath, data, "utf8");
  await rename(tmpPath, filePath);
  return `Written: ${filePath}`;
}
async function toolList() {
  const dir = stateDir();
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
      serverInfo: { name: "omm-state", version: "0.2.0" },
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
      } else if (params.name === "omm_state_write") {
        const key = args.key;
        const value = args.value;
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
