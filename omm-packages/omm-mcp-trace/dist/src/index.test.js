import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
const SERVER_PATH = fileURLToPath(new URL("./index.js", import.meta.url));
class McpClient {
  proc;
  buffer = "";
  waiters = new Map();
  nextId = 1;
  constructor(stateRoot) {
    this.proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, OMM_STATE_ROOT: stateRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      while (true) {
        const idx = this.buffer.indexOf("\n");
        if (idx === -1) break;
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) {
            const waiter = this.waiters.get(msg.id);
            if (waiter) {
              this.waiters.delete(msg.id);
              waiter(msg);
            }
          }
        } catch {
          // ignore malformed
        }
      }
    });
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 5000);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}
async function withClient(fn) {
  const stateRoot = await mkdtemp(join(tmpdir(), "omm-trace-test-"));
  const client = new McpClient(stateRoot);
  try {
    await fn(client, stateRoot);
  } finally {
    client.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
}
async function callTool(client, name, args) {
  return client.send("tools/call", { name, arguments: args });
}
const ev = (timestamp, type, extra = {}) => ({
  timestamp,
  type,
  ...extra,
});
describe("omm-trace MCP server", () => {
  describe("handshake", () => {
    it("responds to initialize with omm-trace serverInfo", async () => {
      await withClient(async (client) => {
        const r = await client.send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        });
        const result = r.result;
        assert.equal(result.protocolVersion, "2024-11-05");
        const serverInfo = result.serverInfo;
        assert.equal(serverInfo.name, "omm-trace");
        assert.equal(serverInfo.version, "0.2.0");
      });
    });
  });
  describe("tools/list", () => {
    it("returns the three trace tools", async () => {
      await withClient(async (client) => {
        const r = await client.send("tools/list");
        const result = r.result;
        const names = result.tools.map((t) => t.name).sort();
        assert.deepEqual(names, [
          "omm_trace_list_sessions",
          "omm_trace_query",
          "omm_trace_record",
        ]);
      });
    });
  });
  describe("record + query", () => {
    it("records and queries back events for a session", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_trace_record", {
          session_id: "s1",
          event: ev("2026-04-26T10:00:00Z", "start", { mode: "ralph" }),
        });
        await callTool(client, "omm_trace_record", {
          session_id: "s1",
          event: ev("2026-04-26T10:01:00Z", "step_complete", { step: 1 }),
        });
        const r = await callTool(client, "omm_trace_query", {
          session_id: "s1",
        });
        const result = r.result;
        const events = JSON.parse(result.content[0].text);
        assert.equal(events.length, 2);
        assert.equal(events[0].type, "start");
        assert.equal(events[1].type, "step_complete");
      });
    });
    it("query returns empty array when session has no trace", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_query", {
          session_id: "absent",
        });
        const result = r.result;
        assert.equal(result.content[0].text, "[]");
      });
    });
    it("filters events by since (inclusive)", async () => {
      await withClient(async (client) => {
        for (const t of ["10:00:00Z", "10:05:00Z", "10:10:00Z"]) {
          await callTool(client, "omm_trace_record", {
            session_id: "s1",
            event: ev(`2026-04-26T${t}`, "tick"),
          });
        }
        const r = await callTool(client, "omm_trace_query", {
          session_id: "s1",
          since: "2026-04-26T10:05:00Z",
        });
        const events = JSON.parse(r.result.content[0].text);
        assert.equal(events.length, 2);
      });
    });
    it("filters events by until (inclusive)", async () => {
      await withClient(async (client) => {
        for (const t of ["10:00:00Z", "10:05:00Z", "10:10:00Z"]) {
          await callTool(client, "omm_trace_record", {
            session_id: "s1",
            event: ev(`2026-04-26T${t}`, "tick"),
          });
        }
        const r = await callTool(client, "omm_trace_query", {
          session_id: "s1",
          until: "2026-04-26T10:05:00Z",
        });
        const events = JSON.parse(r.result.content[0].text);
        assert.equal(events.length, 2);
      });
    });
    it("filters by combined since + until range", async () => {
      await withClient(async (client) => {
        for (const t of ["10:00:00Z", "10:05:00Z", "10:10:00Z", "10:15:00Z"]) {
          await callTool(client, "omm_trace_record", {
            session_id: "s1",
            event: ev(`2026-04-26T${t}`, "tick"),
          });
        }
        const r = await callTool(client, "omm_trace_query", {
          session_id: "s1",
          since: "2026-04-26T10:05:00Z",
          until: "2026-04-26T10:10:00Z",
        });
        const events = JSON.parse(r.result.content[0].text);
        assert.equal(events.length, 2);
        assert.equal(events[0].timestamp, "2026-04-26T10:05:00Z");
        assert.equal(events[1].timestamp, "2026-04-26T10:10:00Z");
      });
    });
    it("isolates sessions — querying one does not return another's events", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_trace_record", {
          session_id: "alpha",
          event: ev("2026-04-26T10:00:00Z", "alpha-event"),
        });
        await callTool(client, "omm_trace_record", {
          session_id: "beta",
          event: ev("2026-04-26T10:00:00Z", "beta-event"),
        });
        const r = await callTool(client, "omm_trace_query", {
          session_id: "alpha",
        });
        const events = JSON.parse(r.result.content[0].text);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "alpha-event");
      });
    });
  });
  describe("validation", () => {
    it("rejects event without timestamp", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_record", {
          session_id: "s1",
          event: { type: "x" },
        });
        assert.equal(r.error?.code, -32000);
        assert.match(r.error?.message ?? "", /timestamp/);
      });
    });
    it("rejects event with invalid timestamp", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_record", {
          session_id: "s1",
          event: { timestamp: "not a date", type: "x" },
        });
        assert.equal(r.error?.code, -32000);
      });
    });
    it("rejects event without type", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_record", {
          session_id: "s1",
          event: { timestamp: "2026-04-26T10:00:00Z" },
        });
        assert.equal(r.error?.code, -32000);
        assert.match(r.error?.message ?? "", /type/);
      });
    });
    it("rejects non-object event", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_record", {
          session_id: "s1",
          event: "not an object",
        });
        assert.equal(r.error?.code, -32000);
      });
    });
    it("rejects bad since/until in query", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_query", {
          session_id: "s1",
          since: "garbage",
        });
        assert.equal(r.error?.code, -32000);
      });
    });
    it("rejects path traversal in session_id (record)", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_record", {
          session_id: "../escape",
          event: ev("2026-04-26T10:00:00Z", "x"),
        });
        assert.equal(r.error?.code, -32000);
        assert.match(r.error?.message ?? "", /session_id/);
      });
    });
    it("rejects path traversal in session_id (query)", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_query", {
          session_id: "foo/bar",
        });
        assert.equal(r.error?.code, -32000);
      });
    });
  });
  describe("list_sessions", () => {
    it("lists session IDs after recording", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_trace_record", {
          session_id: "alpha",
          event: ev("2026-04-26T10:00:00Z", "x"),
        });
        await callTool(client, "omm_trace_record", {
          session_id: "beta",
          event: ev("2026-04-26T10:00:00Z", "x"),
        });
        const r = await callTool(client, "omm_trace_list_sessions", {});
        const sessions = JSON.parse(r.result.content[0].text);
        assert.ok(sessions.includes("alpha"));
        assert.ok(sessions.includes("beta"));
      });
    });
    it("returns empty array when trace dir does not exist", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_list_sessions", {});
        const result = r.result;
        assert.equal(result.content[0].text, "[]");
      });
    });
  });
  describe("error handling", () => {
    it("returns -32601 for unknown tool", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_bogus", {});
        assert.equal(r.error?.code, -32601);
      });
    });
  });
});
//# sourceMappingURL=index.test.js.map
