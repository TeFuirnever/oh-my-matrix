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

  notify(method: string, params?: unknown): void {
    void method;
    void params;
    // unused but kept for future tests
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
  const stateRoot = await mkdtemp(join(tmpdir(), "omm-mcp-test-"));
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

describe("omm-mcp server", () => {
  describe("handshake", () => {
    it("responds to initialize with protocol version and capabilities", async () => {
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
        assert.equal(serverInfo.name, "omm-state");
        assert.equal(serverInfo.version, "0.4.0");
      });
    });
  });

  describe("tools/list", () => {
    it("returns the three omm_state tools", async () => {
      await withClient(async (client) => {
        const r = await client.send("tools/list");
        const result = r.result as { tools: Array<{ name: string }> };
        const names = result.tools.map((t) => t.name).sort();
        assert.deepEqual(names, [
          "omm_state_list",
          "omm_state_read",
          "omm_state_write",
        ]);
      });
    });
  });

  describe("tools/call", () => {
    it("writes and reads back a state file", async () => {
      await withClient(async (client) => {
        const w = await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: false, status: "complete" },
        });
        assert.equal(w.error, undefined);
        const r = await callTool(client, "omm_state_read", { key: "ralph" });
        const result = r.result as { content: Array<{ text: string }> };
        const data = JSON.parse(result.content[0].text);
        assert.equal(data.status, "complete");
      });
    });

    it("lists state keys", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: false, status: "complete" },
        });
        await callTool(client, "omm_state_write", {
          key: "custom-data",
          value: { foo: 1 },
        });
        const r = await callTool(client, "omm_state_list", {});
        const result = r.result as { content: Array<{ text: string }> };
        const keys = JSON.parse(result.content[0].text) as string[];
        assert.ok(keys.includes("ralph"));
        assert.ok(keys.includes("custom-data"));
      });
    });

    it("rejects path traversal in write", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_state_write", {
          key: "../escape",
          value: { foo: 1 },
        });
        assert.equal(r.error?.code, -32000);
        assert.match(r.error?.message ?? "", /key must match/);
      });
    });

    it("rejects path traversal in read", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_state_read", {
          key: "foo/bar",
        });
        assert.equal(r.error?.code, -32000);
      });
    });

    it("rejects unknown tool name", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_state_bogus", {});
        assert.equal(r.error?.code, -32601);
      });
    });

    it("rejects invalid state via inline validator", async () => {
      await withClient(async (client) => {
        const r = await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", status: "bogus-phase" },
        });
        assert.equal(r.error?.code, -32000);
      });
    });
  });

  describe("workflow exclusivity guard (MCP path)", () => {
    it("rejects autopilot active=true while ralph is active", async () => {
      await withClient(async (client) => {
        const a = await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: true },
        });
        assert.equal(a.error, undefined);
        const b = await callTool(client, "omm_state_write", {
          key: "autopilot",
          value: { mode: "autopilot", active: true },
        });
        assert.equal(b.error?.code, -32000);
        assert.match(b.error?.message ?? "", /ralph is already active/);
      });
    });

    it("allows same-mode overwrite", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: true },
        });
        const r = await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: true, iteration: 5 },
        });
        assert.equal(r.error, undefined);
      });
    });

    it("allows team with linked_ralph alongside ralph", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: true },
        });
        const r = await callTool(client, "omm_state_write", {
          key: "team",
          value: { mode: "team", active: true, linked_ralph: true },
        });
        assert.equal(r.error, undefined);
      });
    });

    it("allows autopilot after ralph terminates", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: true },
        });
        await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: false, status: "complete" },
        });
        const r = await callTool(client, "omm_state_write", {
          key: "autopilot",
          value: { mode: "autopilot", active: true },
        });
        assert.equal(r.error, undefined);
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

    it("returns -32600 for requests exceeding 1 MiB", async () => {
      await withClient(async (client) => {
        // Build a >1 MiB single line. Use raw line because send() would
        // wait by id, but the cap response uses id=null.
        const filler = "x".repeat(1 << 20);
        const r = await client.sendRaw(
          `{"jsonrpc":"2.0","id":99,"method":"tools/list","params":"${filler}"}`,
        );
        assert.equal(r.error?.code, -32600);
        assert.match(r.error?.message ?? "", /exceeds \d+-byte limit/);
      });
    });
  });

  describe("initialize advertises Resources + Prompts capabilities", () => {
    it("returns capabilities including resources and prompts", async () => {
      await withClient(async (client) => {
        const r = await client.send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        });
        const caps = (r.result as { capabilities: Record<string, unknown> })
          .capabilities;
        assert.deepEqual(caps, { tools: {}, resources: {}, prompts: {} });
      });
    });
  });

  describe("Resources (omm://state/<key>)", () => {
    it("resources/list returns written state files as omm://state/<key>", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: false },
        });
        const r = await client.send("resources/list");
        const resources = (r.result as { resources: Array<{ uri: string }> })
          .resources;
        const uris = resources.map((x) => x.uri);
        assert.ok(
          uris.includes("omm://state/ralph"),
          `expected omm://state/ralph in ${JSON.stringify(uris)}`,
        );
      });
    });

    it("resources/read returns JSON content for valid URI", async () => {
      await withClient(async (client) => {
        await callTool(client, "omm_state_write", {
          key: "ralph",
          value: { mode: "ralph", active: false, note: "unit-test" },
        });
        const r = await client.send("resources/read", {
          uri: "omm://state/ralph",
        });
        const contents = (
          r.result as {
            contents: Array<{ uri: string; mimeType: string; text: string }>;
          }
        ).contents;
        assert.equal(contents[0].uri, "omm://state/ralph");
        assert.equal(contents[0].mimeType, "application/json");
        assert.match(contents[0].text, /"note": "unit-test"/);
      });
    });

    it("resources/read rejects malformed URI with OMM_E_KEY_INVALID", async () => {
      await withClient(async (client) => {
        const r = await client.send("resources/read", {
          uri: "omm://bad/xyz",
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

  describe("Prompts (agent-prompts/<name>.md)", () => {
    it("prompts/list includes the sentinel prompts (analyst + planner)", async () => {
      await withClient(async (client) => {
        const r = await client.send("prompts/list");
        const prompts = (
          r.result as { prompts: Array<{ name: string }> }
        ).prompts.map((p) => p.name);
        assert.ok(
          prompts.includes("analyst"),
          `expected 'analyst' in ${JSON.stringify(prompts)}`,
        );
        assert.ok(
          prompts.includes("planner"),
          `expected 'planner' in ${JSON.stringify(prompts)}`,
        );
      });
    });

    it("prompts/get returns the prompt body as a system message", async () => {
      await withClient(async (client) => {
        const r = await client.send("prompts/get", { name: "analyst" });
        const result = r.result as {
          description: string;
          messages: Array<{
            role: string;
            content: { type: string; text: string };
          }>;
        };
        assert.match(result.description, /analyst/);
        assert.equal(result.messages.length, 1);
        assert.equal(result.messages[0].role, "system");
        assert.equal(result.messages[0].content.type, "text");
        assert.ok(
          result.messages[0].content.text.length > 100,
          "prompt body too short",
        );
      });
    });

    it("prompts/get rejects invalid name with OMM_E_KEY_INVALID", async () => {
      await withClient(async (client) => {
        const r = await client.send("prompts/get", { name: "1bad" });
        assert.ok(r.error, "expected error response");
        const data = (
          r.error as unknown as {
            data?: { code?: string };
          }
        ).data;
        assert.equal(data?.code, "OMM_E_KEY_INVALID");
      });
    });
  });
});
