/**
 * End-to-end smoke test for the 3 omm MCP servers.
 *
 * Spawns each server (omm-state, omm-memory, omm-trace) as the host
 * (mcporter / MatrixAssistant) does, sends `initialize` + `tools/list`
 * + one real tool roundtrip per server, and reports per-server pass/
 * fail. Exit code 0 only if all 3 servers pass every check.
 *
 * Usage:
 *   node omm-scripts/omm-smoke-mcp.mjs
 *
 * Optional env:
 *   OMM_SMOKE_STATE_ROOT  override the tmp stateRoot (default: mkdtemp)
 *   OMM_SMOKE_VERBOSE=1   dump every JSON-RPC frame
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERBOSE = process.env.OMM_SMOKE_VERBOSE === "1";
const EXPECTED_VERSION = "0.3.0";

const SERVERS = [
  {
    name: "omm-state",
    bin: join(ROOT, "omm-packages/omm-mcp/dist/src/index.js"),
    expectedTools: ["omm_state_write", "omm_state_read", "omm_state_list"],
    roundtrip: async (call) => {
      const w = await call("omm_state_write", {
        key: "smoke",
        value: { mode: "ralph", active: false, current_phase: "complete" },
      });
      assertOk(w, "omm_state_write");
      const r = await call("omm_state_read", { key: "smoke" });
      assertOk(r, "omm_state_read");
      if (!r.result.content[0].text.includes('"current_phase":')) {
        throw new Error("omm_state_read returned unexpected payload");
      }
      const l = await call("omm_state_list", {});
      assertOk(l, "omm_state_list");
      const keys = JSON.parse(l.result.content[0].text);
      if (!keys.includes("smoke")) {
        throw new Error(`list did not include 'smoke': ${keys.join(", ")}`);
      }
    },
  },
  {
    name: "omm-memory",
    bin: join(ROOT, "omm-packages/omm-mcp-memory/dist/src/index.js"),
    expectedTools: [
      "omm_memory_set",
      "omm_memory_get",
      "omm_memory_delete",
      "omm_memory_list",
    ],
    roundtrip: async (call) => {
      const s = await call("omm_memory_set", {
        key: "smoke",
        value: { hello: "world" },
      });
      assertOk(s, "omm_memory_set");
      const g = await call("omm_memory_get", { key: "smoke" });
      assertOk(g, "omm_memory_get");
      const parsed = JSON.parse(g.result.content[0].text);
      if (parsed.hello !== "world") {
        throw new Error("omm_memory_get payload mismatch");
      }
    },
  },
  {
    name: "omm-trace",
    bin: join(ROOT, "omm-packages/omm-mcp-trace/dist/src/index.js"),
    expectedTools: [
      "omm_trace_record",
      "omm_trace_query",
      "omm_trace_list_sessions",
    ],
    roundtrip: async (call) => {
      const ts = new Date().toISOString();
      const rec = await call("omm_trace_record", {
        session_id: "smoke",
        event: { timestamp: ts, type: "smoke.start" },
      });
      assertOk(rec, "omm_trace_record");
      const q = await call("omm_trace_query", { session_id: "smoke" });
      assertOk(q, "omm_trace_query");
      const events = JSON.parse(q.result.content[0].text);
      if (!Array.isArray(events) || events.length === 0) {
        throw new Error("omm_trace_query returned no events");
      }
    },
  },
];

function assertOk(rsp, label) {
  if (rsp.error) {
    throw new Error(
      `${label} returned -${rsp.error.code}: ${rsp.error.message}`,
    );
  }
  if (!rsp.result) {
    throw new Error(`${label} returned no result`);
  }
}

class Client {
  constructor(bin, stateRoot) {
    this.proc = spawn(process.execPath, [bin], {
      env: { ...process.env, OMM_STATE_ROOT: stateRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.buffer = "";
    this.waiters = new Map();
    this.nextId = 1;
    this.proc.stdout.on("data", (chunk) => {
      if (VERBOSE) process.stderr.write(`«${chunk}`);
      this.buffer += chunk;
      while (true) {
        const i = this.buffer.indexOf("\n");
        if (i === -1) break;
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.waiters.has(msg.id)) {
            const fn = this.waiters.get(msg.id);
            this.waiters.delete(msg.id);
            fn(msg);
          }
        } catch {
          /* ignore malformed (e.g. notifications) */
        }
      }
    });
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 5000);
      this.waiters.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      if (VERBOSE) process.stderr.write(`»${frame}`);
      this.proc.stdin.write(frame);
    });
  }
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function smokeOne(server, stateRoot) {
  const client = new Client(server.bin, stateRoot);
  try {
    const init = await client.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "omm-smoke", version: "1.0.0" },
    });
    assertOk(init, "initialize");
    const serverInfo = init.result.serverInfo;
    if (serverInfo.version !== EXPECTED_VERSION) {
      throw new Error(
        `serverInfo.version mismatch: expected ${EXPECTED_VERSION}, got ${serverInfo.version}`,
      );
    }
    if (serverInfo.name !== server.name) {
      throw new Error(
        `serverInfo.name mismatch: expected ${server.name}, got ${serverInfo.name}`,
      );
    }
    const list = await client.send("tools/list");
    assertOk(list, "tools/list");
    const got = new Set(list.result.tools.map((t) => t.name));
    for (const expected of server.expectedTools) {
      if (!got.has(expected)) {
        throw new Error(`tools/list missing ${expected}`);
      }
    }
    const call = (name, args) =>
      client.send("tools/call", { name, arguments: args });
    await server.roundtrip(call);
  } finally {
    client.close();
  }
}

async function main() {
  const stateRoot =
    process.env.OMM_SMOKE_STATE_ROOT ??
    (await mkdtemp(join(tmpdir(), "omm-smoke-")));
  const cleanup =
    !process.env.OMM_SMOKE_STATE_ROOT &&
    (() => rm(stateRoot, { recursive: true, force: true }));
  console.log(`stateRoot: ${stateRoot}`);
  let failed = 0;
  for (const server of SERVERS) {
    process.stdout.write(`[${server.name}] `);
    const t = Date.now();
    try {
      await smokeOne(server, stateRoot);
      console.log(`ok (${Date.now() - t}ms)`);
    } catch (err) {
      failed++;
      console.log(`FAIL — ${err instanceof Error ? err.message : err}`);
    }
  }
  if (cleanup) await cleanup();
  if (failed > 0) {
    console.log(`\n${failed}/${SERVERS.length} server(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${SERVERS.length} servers passed.`);
}

await main();
