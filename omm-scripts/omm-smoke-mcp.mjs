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
 *   node omm-scripts/omm-smoke-mcp.mjs --as-ma-consumer
 *
 * --as-ma-consumer:
 *   In addition to the tools roundtrip, exercises the MCP methods that
 *   MatrixAssistant's TransportBridge actually invokes when surfacing
 *   omm Resources and Prompts in its UI:
 *     - resources/list (omm-state, omm-trace)
 *     - resources/read (omm://state/<key>, omm://trace/<sessionId>)
 *     - prompts/list   (omm-state)
 *   Asserts the wire envelope matches docs/contracts/mcp-protocol-contract.md
 *   and writes evidence to .omc/state/ma-roundtrip-evidence.json. Used to
 *   close the Phase 4 exit "MA UI confirmed to consume omm Resources
 *   end-to-end" (docs/roadmap.md).
 *
 * Optional env:
 *   OMM_SMOKE_STATE_ROOT  override the tmp stateRoot (default: mkdtemp)
 *   OMM_SMOKE_VERBOSE=1   dump every JSON-RPC frame
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERBOSE = process.env.OMM_SMOKE_VERBOSE === "1";
const AS_MA_CONSUMER = process.argv.includes("--as-ma-consumer");
const EXPECTED_VERSION = JSON.parse(
  await readFile(join(ROOT, "package.json"), "utf8"),
).version;

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

// ── MA-consumer probes ─────────────────────────────────────────────
// Per docs/contracts/mcp.md capability matrix (post-R1):
//   omm-state:  tools + resources + prompts
//   omm-trace:  tools + resources
//   omm-memory: tools only (no resources/prompts) — skipped here
const MA_CONSUMER_PROBES = {
  "omm-state": {
    expectResources: true,
    expectPrompts: true,
    seedThenProbe: async (call) => {
      // The tools roundtrip already wrote {key:"smoke"}; resources
      // surface should advertise omm://state/smoke.
      const list = await call("resources/list", {});
      assertOk(list, "omm-state resources/list");
      const uris = list.result.resources?.map((r) => r.uri) ?? [];
      const target = uris.find((u) => u === "omm://state/smoke");
      if (!target) {
        throw new Error(
          `resources/list missing omm://state/smoke (got: ${uris.join(", ") || "none"})`,
        );
      }
      const read = await call("resources/read", { uri: target });
      assertOk(read, "omm-state resources/read");
      const contents = read.result.contents ?? [];
      if (contents.length === 0) {
        throw new Error("omm://state/smoke read returned empty contents");
      }
      const first = contents[0];
      if (first.uri !== target) {
        throw new Error(
          `resources/read uri mismatch: expected ${target}, got ${first.uri}`,
        );
      }
      if (first.mimeType !== "application/json") {
        throw new Error(
          `resources/read mimeType expected application/json, got ${first.mimeType}`,
        );
      }
      const promptsList = await call("prompts/list", {});
      assertOk(promptsList, "omm-state prompts/list");
      const prompts = promptsList.result.prompts ?? [];
      if (prompts.length === 0) {
        throw new Error(
          "prompts/list returned empty — expected at least one omm://prompts/<name>",
        );
      }
      return {
        resources_count: uris.length,
        sample_resource_uri: target,
        sample_resource_mime: first.mimeType,
        prompts_count: prompts.length,
        sample_prompt_name: prompts[0].name,
      };
    },
  },
  "omm-trace": {
    expectResources: true,
    expectPrompts: false,
    seedThenProbe: async (call) => {
      // tools roundtrip already recorded a smoke event; resources
      // surface should advertise omm://trace/smoke.
      const list = await call("resources/list", {});
      assertOk(list, "omm-trace resources/list");
      const uris = list.result.resources?.map((r) => r.uri) ?? [];
      const target = uris.find((u) => u === "omm://trace/smoke");
      if (!target) {
        throw new Error(
          `resources/list missing omm://trace/smoke (got: ${uris.join(", ") || "none"})`,
        );
      }
      const read = await call("resources/read", { uri: target });
      assertOk(read, "omm-trace resources/read");
      const contents = read.result.contents ?? [];
      if (contents.length === 0) {
        throw new Error("omm://trace/smoke read returned empty contents");
      }
      const first = contents[0];
      if (first.uri !== target) {
        throw new Error(
          `resources/read uri mismatch: expected ${target}, got ${first.uri}`,
        );
      }
      if (first.mimeType !== "application/x-jsonlines") {
        throw new Error(
          `resources/read mimeType expected application/x-jsonlines, got ${first.mimeType}`,
        );
      }
      return {
        resources_count: uris.length,
        sample_resource_uri: target,
        sample_resource_mime: first.mimeType,
      };
    },
  },
  // omm-memory: no resources, no prompts — verified by capability matrix only
  "omm-memory": {
    expectResources: false,
    expectPrompts: false,
    seedThenProbe: async (call) => {
      // Confirm the server honestly does NOT advertise resources/list
      // (or returns empty). Either is acceptable per capability matrix.
      try {
        const list = await call("resources/list", {});
        if (
          list.result?.resources?.length &&
          list.result.resources.length > 0
        ) {
          throw new Error(
            "omm-memory unexpectedly advertised resources — capability matrix says none",
          );
        }
        return { resources_advertised: false };
      } catch (err) {
        // -32601 method not found is also acceptable
        if (err.message?.includes("-32601")) {
          return { resources_advertised: false, method_not_found: true };
        }
        throw err;
      }
    },
  },
};

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
  const evidence = { name: server.name, initialize: null, ma_consumer: null };
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
    evidence.initialize = {
      protocol_version: init.result.protocolVersion,
      server_name: serverInfo.name,
      server_version: serverInfo.version,
      capabilities: init.result.capabilities ?? {},
    };
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
    if (AS_MA_CONSUMER) {
      const probe = MA_CONSUMER_PROBES[server.name];
      if (!probe) {
        throw new Error(`no MA-consumer probe defined for ${server.name}`);
      }
      const rawCall = (method, params) => client.send(method, params);
      evidence.ma_consumer = await probe.seedThenProbe(rawCall);
    }
  } finally {
    client.close();
  }
  return evidence;
}

async function main() {
  const stateRoot =
    process.env.OMM_SMOKE_STATE_ROOT ??
    (await mkdtemp(join(tmpdir(), "omm-smoke-")));
  const cleanup =
    !process.env.OMM_SMOKE_STATE_ROOT &&
    (() => rm(stateRoot, { recursive: true, force: true }));
  console.log(`stateRoot: ${stateRoot}`);
  if (AS_MA_CONSUMER) {
    console.log("mode: --as-ma-consumer (resources + prompts probes)");
  }
  let failed = 0;
  const perServer = [];
  for (const server of SERVERS) {
    process.stdout.write(`[${server.name}] `);
    const t = Date.now();
    try {
      const evidence = await smokeOne(server, stateRoot);
      const ms = Date.now() - t;
      perServer.push({ ...evidence, status: "ok", elapsed_ms: ms });
      console.log(`ok (${ms}ms)`);
    } catch (err) {
      failed++;
      const ms = Date.now() - t;
      perServer.push({
        name: server.name,
        status: "fail",
        error: err instanceof Error ? err.message : String(err),
        elapsed_ms: ms,
      });
      console.log(`FAIL — ${err instanceof Error ? err.message : err}`);
    }
  }
  if (AS_MA_CONSUMER && failed === 0) {
    const evidenceDir = join(ROOT, ".omc", "state");
    await mkdir(evidenceDir, { recursive: true });
    const evidencePath = join(evidenceDir, "ma-roundtrip-evidence.json");
    const payload = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      omm_version: EXPECTED_VERSION,
      protocol_version: "2024-11-05",
      mode: "as-ma-consumer",
      servers: perServer,
      wire_contract: "docs/contracts/mcp-protocol-contract.md",
      consumer_contract: "docs/contracts/ma-integration-snippets.md",
    };
    await writeFile(evidencePath, JSON.stringify(payload, null, 2) + "\n");
    console.log(`evidence: ${evidencePath}`);
  }
  if (cleanup) await cleanup();
  if (failed > 0) {
    console.log(`\n${failed}/${SERVERS.length} server(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${SERVERS.length} servers passed.`);
}

await main();
