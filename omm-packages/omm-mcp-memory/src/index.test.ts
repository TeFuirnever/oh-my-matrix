import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

  sendRaw(line: string): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      const handler = (chunk: string) => {
        const newlineIdx = chunk.indexOf("\n");
        if (newlineIdx === -1) return;
        const lineOut = chunk.slice(0, newlineIdx).trim();
        if (!lineOut) return;
        try {
          const msg = JSON.parse(lineOut) as JsonRpcResponse;
          clearTimeout(timer);
          this.proc.stdout.off("data", handler);
          resolve(msg);
        } catch {
          // continue
        }
      };
      this.proc.stdout.on("data", handler);
      this.proc.stdin.write(`${line}\n`);
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
  const stateRoot = await mkdtemp(join(tmpdir(), "omm-memory-test-"));
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

describe("omm-memory MCP server", () => {
  describe("handshake", () => {
    it("responds to initialize with omm-memory serverInfo", async () => {
      await withClient(async (client) => {
        const r = await client.send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        });
        assert.equal(r.error, undefined);
        const result = r.result as Record<string, unknown>;
        assert.equal(result.protocolVersion, "2024-11-05");
        const serverInfo = result.serverInfo as Record<string, string>;
        assert.equal(serverInfo.name, "omm-memory");
        assert.equal(serverInfo.version, "0.3.0");
      });
    });
  });

  describe("tools/list", () => {
    it("returns the four omm_memory tools", async () => {
      await withClient(async (client) => {
        const r = await client.send("tools/list");
        const result = r.result as { tools: Array<{ name: string }> };
        const names = result.tools.map((t) => t.name).sort();
        assert.deepEqual(names, [
          "omm_memory_delete",
          "omm_memory_get",
          "omm_memory_list",
          "omm_memory_set",
        ]);
      });
    });
  });

  describe("tools/call", () => {
    it("set + get round-trip", async () => {
      await withClient(async (client) => {
        const s = await callTool(client, "omm_memory_set", {
          key: "user-pref",
          value: { theme: "dark", lang: "en" },
        });
        assert.equal(s.error, undefined);

        const g = await callTool(client, "omm_memory_get", {
          key: "user-pref",
        });
        const result = g.result as { content: Array<{ text: string }> };
        const data = JSON.parse(result.content[0].text);
        assert.equal(data.theme, "dark");
        assert.equal(data.lang, "en");
      });
    });

    it("get returns null for missing key", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_get", { key: "absent" });
        const result = r.result as { content: Array<{ text: string }> };
        assert.equal(result.content[0].text, "null");
      });
    });

    it("list returns keys after writes", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_memory_set", {
          key: "a",
          value: { v: 1 },
        });
        await callTool(client, "omm_memory_set", {
          key: "b",
          value: { v: 2 },
        });
        const r = await callTool(client, "omm_memory_list", {});
        const result = r.result as { content: Array<{ text: string }> };
        const keys = JSON.parse(result.content[0].text) as string[];
        assert.ok(keys.includes("a"));
        assert.ok(keys.includes("b"));
      });
    });

    it("list returns empty array when memory dir does not exist", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_list", {});
        const result = r.result as { content: Array<{ text: string }> };
        assert.equal(result.content[0].text, "[]");
      });
    });

    it("delete removes the key", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_memory_set", {
          key: "tmp",
          value: { v: 1 },
        });
        const d = await callTool(client, "omm_memory_delete", { key: "tmp" });
        const dResult = d.result as { content: Array<{ text: string }> };
        assert.match(dResult.content[0].text, /^Deleted: /);

        const g = await callTool(client, "omm_memory_get", { key: "tmp" });
        const gResult = g.result as { content: Array<{ text: string }> };
        assert.equal(gResult.content[0].text, "null");
      });
    });

    it("delete is idempotent on missing key", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_delete", {
          key: "never-existed",
        });
        assert.equal(r.error, undefined);
        const result = r.result as { content: Array<{ text: string }> };
        assert.match(result.content[0].text, /^Not found: /);
      });
    });

    it("rejects path traversal in set", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_set", {
          key: "../escape",
          value: { v: 1 },
        });
        assert.equal(r.error?.code, -32000);
        assert.match(r.error?.message ?? "", /key must match/);
      });
    });

    it("rejects path traversal in get", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_get", { key: "foo/bar" });
        assert.equal(r.error?.code, -32000);
      });
    });

    it("rejects path traversal in delete", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_delete", {
          key: "foo\\bar",
        });
        assert.equal(r.error?.code, -32000);
      });
    });

    it("rejects non-object value in set", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_set", {
          key: "bad",
          value: "not an object",
        });
        assert.equal(r.error?.code, -32000);
        assert.match(r.error?.message ?? "", /JSON object/);
      });
    });

    it("rejects array value in set", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_set", {
          key: "bad",
          value: [1, 2, 3],
        });
        assert.equal(r.error?.code, -32000);
      });
    });

    it("rejects null value in set", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_set", {
          key: "bad",
          value: null,
        });
        assert.equal(r.error?.code, -32000);
        assert.match(r.error?.message ?? "", /JSON object/);
      });
    });

    it("rejects unknown tool name", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_memory_bogus", {});
        assert.equal(r.error?.code, -32601);
      });
    });

    it("set overwrites existing key", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_memory_set", {
          key: "k",
          value: { version: 1 },
        });
        await callTool(client, "omm_memory_set", {
          key: "k",
          value: { version: 2 },
        });
        const g = await callTool(client, "omm_memory_get", { key: "k" });
        const result = g.result as { content: Array<{ text: string }> };
        const data = JSON.parse(result.content[0].text);
        assert.equal(data.version, 2);
      });
    });
  });

  describe("error handling", () => {
    it("returns -32700 for invalid JSON", async () => {
      await withClient(async (client) => {
        const r = await client.sendRaw("{not valid json");
        assert.equal(r.error?.code, -32700);
      });
    });

    it("returns -32601 for unknown method", async () => {
      await withClient(async (client) => {
        const r = await client.send("foo/bar");
        assert.equal(r.error?.code, -32601);
      });
    });
  });
});
