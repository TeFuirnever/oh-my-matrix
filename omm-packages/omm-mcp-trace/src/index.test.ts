import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("./index.js", import.meta.url));

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiters = new Map<
    string | number,
    (response: JsonRpcResponse) => void
  >();
  private nextId = 1;

  constructor(stateRoot: string) {
    this.proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, OMM_STATE_ROOT: stateRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      while (true) {
        const idx = this.buffer.indexOf("\n");
        if (idx === -1) break;
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
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

  send(method: string, params?: unknown): Promise<JsonRpcResponse> {
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

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

async function withClient(
  fn: (client: McpClient, stateRoot: string) => Promise<void>,
): Promise<void> {
  const stateRoot = await mkdtemp(join(tmpdir(), "omm-trace-test-"));
  const client = new McpClient(stateRoot);
  try {
    await fn(client, stateRoot);
  } finally {
    client.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function callTool(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  return client.send("tools/call", { name, arguments: args });
}

const ev = (
  timestamp: string,
  type: string,
  extra: Record<string, unknown> = {},
) => ({
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
        const result = r.result as Record<string, unknown>;
        assert.equal(result.protocolVersion, "2024-11-05");
        const serverInfo = result.serverInfo as Record<string, string>;
        assert.equal(serverInfo.name, "omm-trace");
        assert.equal(serverInfo.version, "0.4.2");
      });
    });
  });

  describe("tools/list", () => {
    it("returns the four trace tools", async () => {
      await withClient(async (client) => {
        const r = await client.send("tools/list");
        const result = r.result as { tools: Array<{ name: string }> };
        const names = result.tools.map((t) => t.name).sort();
        assert.deepEqual(names, [
          "omm_trace_list_sessions",
          "omm_trace_metrics",
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
          event: ev("2026-04-26T10:00:00Z", "start", { mode: "team" }),
        });
        await callTool(client, "omm_trace_record", {
          session_id: "s1",
          event: ev("2026-04-26T10:01:00Z", "step_complete", { step: 1 }),
        });
        const r = await callTool(client, "omm_trace_query", {
          session_id: "s1",
        });
        const result = r.result as { content: Array<{ text: string }> };
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
        const result = r.result as { content: Array<{ text: string }> };
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
        const events = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
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
        const events = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
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
        const events = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
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
        const events = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
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
        const sessions = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
        assert.ok(sessions.includes("alpha"));
        assert.ok(sessions.includes("beta"));
      });
    });

    it("returns empty array when trace dir does not exist", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_list_sessions", {});
        const result = r.result as { content: Array<{ text: string }> };
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

  describe("metrics", () => {
    const metricEv = (
      timestamp: string,
      toolName: string,
      durationMs: number,
      ok: boolean,
    ) => ({ timestamp, type: "tool_call", toolName, durationMs, ok });

    it("aggregates 10 records with durationMs 1..10, all ok, same toolName", async () => {
      await withClient(async (client) => {
        for (let i = 1; i <= 10; i++) {
          const ts = `2026-04-26T10:00:${String(i).padStart(2, "0")}Z`;
          await callTool(client, "omm_trace_record", {
            session_id: "m1",
            event: metricEv(ts, "toolA", i, true),
          });
        }
        const r = await callTool(client, "omm_trace_metrics", {
          sessionId: "m1",
        });
        const result = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
        assert.equal(result.count, 10);
        assert.equal(result.errorRate, 0);
        assert.ok(result.p50 >= 5 && result.p50 <= 6, `p50=${result.p50}`);
        assert.equal(result.p99, 10);
      });
    });

    it("computes errorRate correctly with 2 failures out of 5", async () => {
      await withClient(async (client) => {
        for (let i = 0; i < 5; i++) {
          await callTool(client, "omm_trace_record", {
            session_id: "m2",
            event: metricEv(`2026-04-26T10:00:0${i}Z`, "toolB", 10 + i, i < 3),
          });
        }
        const r = await callTool(client, "omm_trace_metrics", {
          sessionId: "m2",
        });
        const result = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
        assert.equal(result.count, 5);
        assert.ok(
          Math.abs(result.errorRate - 0.4) < 0.001,
          `errorRate=${result.errorRate}`,
        );
      });
    });

    it("splits byTool buckets independently across 2 toolNames", async () => {
      await withClient(async (client) => {
        for (let i = 0; i < 3; i++) {
          await callTool(client, "omm_trace_record", {
            session_id: "m3",
            event: metricEv(`2026-04-26T10:00:0${i}Z`, "alpha", i + 1, true),
          });
          await callTool(client, "omm_trace_record", {
            session_id: "m3",
            event: metricEv(
              `2026-04-26T10:00:0${i + 3}Z`,
              "beta",
              (i + 1) * 10,
              false,
            ),
          });
        }
        const r = await callTool(client, "omm_trace_metrics", {
          sessionId: "m3",
        });
        const result = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
        assert.equal(result.byTool.alpha.count, 3);
        assert.equal(result.byTool.alpha.errorRate, 0);
        assert.equal(result.byTool.beta.count, 3);
        assert.equal(result.byTool.beta.errorRate, 1);
      });
    });

    it("returns zeros on empty trace (no division by zero)", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_trace_metrics", {
          sessionId: "empty-session",
        });
        const result = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
        assert.equal(result.count, 0);
        assert.equal(result.errorRate, 0);
        assert.equal(result.p50, 0);
        assert.equal(result.p99, 0);
        assert.deepEqual(result.byTool, {});
      });
    });

    it("sinceMs filter excludes old records", async () => {
      await withClient(async (client) => {
        const old = new Date(Date.now() - 120_000).toISOString();
        const fresh = new Date().toISOString();
        await callTool(client, "omm_trace_record", {
          session_id: "mtime",
          event: {
            timestamp: old,
            type: "tool_call",
            toolName: "t",
            durationMs: 999,
            ok: true,
          },
        });
        await callTool(client, "omm_trace_record", {
          session_id: "mtime",
          event: {
            timestamp: fresh,
            type: "tool_call",
            toolName: "t",
            durationMs: 1,
            ok: true,
          },
        });
        const r = await callTool(client, "omm_trace_metrics", {
          sessionId: "mtime",
          sinceMs: 60_000,
        });
        const result = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
        assert.equal(result.count, 1);
        assert.equal(result.p50, 1);
      });
    });

    it("sessionId filter scopes to the correct session only", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_trace_record", {
          session_id: "scope-a",
          event: metricEv("2026-04-26T10:00:00Z", "t", 5, true),
        });
        await callTool(client, "omm_trace_record", {
          session_id: "scope-b",
          event: metricEv("2026-04-26T10:00:01Z", "t", 100, false),
        });
        const r = await callTool(client, "omm_trace_metrics", {
          sessionId: "scope-a",
        });
        const result = JSON.parse(
          (r.result as { content: Array<{ text: string }> }).content[0].text,
        );
        assert.equal(result.count, 1);
        assert.equal(result.p50, 5);
        assert.equal(result.errorRate, 0);
      });
    });
  });

  describe("rotation", () => {
    // Rotation triggers at 8 MiB. We pre-seed an oversized JSONL so that
    // the next record() call rotates the file rather than appending past
    // the threshold. This avoids writing 8 MiB inside the test.
    const ROTATE_BYTES = 8 << 20;

    it("rotates the session JSONL when it exceeds 8 MiB and queries still see all events", async () => {
      await withClient(async (client, stateRoot) => {
        const traceDir = join(stateRoot, "trace");
        await mkdir(traceDir, { recursive: true });
        const sessionFile = join(traceDir, "rotsess.jsonl");

        // Seed: one valid event followed by padding to push size past the
        // rotate threshold. Padding is a JSON line that fails validation
        // (no `type`) — it is preserved across rotation but skipped at
        // query time.
        const seedEvent = `${JSON.stringify(ev("2026-04-26T00:00:00Z", "seed"))}\n`;
        const padding = `${"x".repeat(ROTATE_BYTES)}\n`;
        await writeFile(sessionFile, seedEvent + padding, "utf8");

        // Trigger rotation by recording a fresh event.
        const r1 = await callTool(client, "omm_trace_record", {
          session_id: "rotsess",
          event: ev("2026-04-26T01:00:00Z", "post-rotate"),
        });
        assert.equal(r1.error, undefined);

        // After rotation: directory contains the archive + a fresh current.
        const files = await readdir(traceDir);
        const archives = files.filter((f) => /^rotsess\.jsonl\.\d+$/.test(f));
        assert.equal(
          archives.length,
          1,
          `expected one archive, got ${files.join(", ")}`,
        );
        assert.ok(
          files.includes("rotsess.jsonl"),
          "expected fresh current file after rotation",
        );

        // Query reads across archive + current, returning the seed event
        // and the post-rotate event in chronological order.
        const r2 = await callTool(client, "omm_trace_query", {
          session_id: "rotsess",
        });
        const text = (r2.result as { content: Array<{ text: string }> })
          .content[0].text;
        const events = JSON.parse(text) as Array<{ type: string }>;
        assert.deepEqual(
          events.map((e) => e.type),
          ["seed", "post-rotate"],
        );
      });
    });

    it("prunes oldest archives beyond the retention cap of 4", async () => {
      await withClient(async (client, stateRoot) => {
        const traceDir = join(stateRoot, "trace");
        await mkdir(traceDir, { recursive: true });

        // Pre-create 5 archives (already past retention) and one current.
        for (let i = 0; i < 5; i++) {
          await writeFile(
            join(traceDir, `pruned.jsonl.${1700000000000 + i}`),
            "",
            "utf8",
          );
        }
        const current = join(traceDir, "pruned.jsonl");
        await writeFile(current, "x".repeat(ROTATE_BYTES + 1), "utf8");

        // Triggering one more rotation must keep at most 4 archives + the
        // newly-rotated archive that came from `current`.
        await callTool(client, "omm_trace_record", {
          session_id: "pruned",
          event: ev("2026-04-26T02:00:00Z", "trigger"),
        });

        const files = await readdir(traceDir);
        const archives = files.filter((f) => /^pruned\.jsonl\.\d+$/.test(f));
        assert.ok(
          archives.length <= 4,
          `expected ≤4 archives after prune, got ${archives.length}: ${archives.join(", ")}`,
        );
      });
    });

    it("list_sessions deduplicates a session that has both current and archives", async () => {
      await withClient(async (client, stateRoot) => {
        const traceDir = join(stateRoot, "trace");
        await mkdir(traceDir, { recursive: true });
        await writeFile(join(traceDir, "dup.jsonl"), "", "utf8");
        await writeFile(join(traceDir, "dup.jsonl.1700000000000"), "", "utf8");
        await writeFile(join(traceDir, "dup.jsonl.1700000000001"), "", "utf8");

        const r = await callTool(client, "omm_trace_list_sessions", {});
        const text = (r.result as { content: Array<{ text: string }> })
          .content[0].text;
        const sessions = JSON.parse(text) as string[];
        assert.deepEqual(sessions, ["dup"]);
      });
    });
  });

  describe("initialize advertises Resources capability", () => {
    it("returns capabilities including resources", async () => {
      await withClient(async (client) => {
        const r = await client.send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        });
        const caps = (r.result as { capabilities: Record<string, unknown> })
          .capabilities;
        assert.deepEqual(caps, { tools: {}, resources: {} });
      });
    });
  });

  describe("Resources (omm://trace/<sessionId>)", () => {
    it("resources/list returns trace files as omm://trace/<sessionId>", async () => {
      await withClient(async (client, stateRoot) => {
        const traceDir = join(stateRoot, "trace");
        await mkdir(traceDir, { recursive: true });
        await writeFile(
          join(traceDir, "session-alpha.jsonl"),
          '{"t":1}\n',
          "utf8",
        );
        const r = await client.send("resources/list");
        const resources = (
          r.result as { resources: Array<{ uri: string; mimeType?: string }> }
        ).resources;
        const uris = resources.map((x) => x.uri);
        assert.ok(
          uris.includes("omm://trace/session-alpha"),
          `expected omm://trace/session-alpha in ${JSON.stringify(uris)}`,
        );
        assert.equal(resources[0].mimeType, "application/x-jsonlines");
      });
    });

    it("resources/read returns JSONL content for valid URI", async () => {
      await withClient(async (client, stateRoot) => {
        const traceDir = join(stateRoot, "trace");
        await mkdir(traceDir, { recursive: true });
        await writeFile(
          join(traceDir, "session-beta.jsonl"),
          '{"event":"a"}\n{"event":"b"}\n',
          "utf8",
        );
        const r = await client.send("resources/read", {
          uri: "omm://trace/session-beta",
        });
        const contents = (
          r.result as {
            contents: Array<{ uri: string; mimeType: string; text: string }>;
          }
        ).contents;
        assert.equal(contents[0].uri, "omm://trace/session-beta");
        assert.equal(contents[0].mimeType, "application/x-jsonlines");
        assert.match(contents[0].text, /"event":"a"/);
      });
    });

    it("resources/read rejects malformed URI with OMM_E_KEY_INVALID", async () => {
      await withClient(async (client) => {
        const r = await client.send("resources/read", {
          uri: "omm://wrong/xyz",
        });
        assert.ok(r.error, "expected error response");
        const data = (
          r.error as unknown as {
            data?: { code?: string };
          }
        ).data;
        assert.equal(data?.code, "OMM_E_KEY_INVALID");
      });
    });

    it("resources/read requires uri param", async () => {
      await withClient(async (client) => {
        const r = await client.send("resources/read", {});
        assert.equal(r.error?.code, -32602);
      });
    });
  });
});
