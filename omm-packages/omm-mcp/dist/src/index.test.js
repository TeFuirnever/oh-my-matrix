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
                if (idx === -1)
                    break;
                const line = this.buffer.slice(0, idx).trim();
                this.buffer = this.buffer.slice(idx + 1);
                if (!line)
                    continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id != null) {
                        const waiter = this.waiters.get(msg.id);
                        if (waiter) {
                            this.waiters.delete(msg.id);
                            waiter(msg);
                        }
                    }
                }
                catch {
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
            this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }
    notify(method, params) {
        void method;
        void params;
        // unused but kept for future tests
    }
    sendRaw(line) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), 5000);
            const handler = (chunk) => {
                const newlineIdx = chunk.indexOf("\n");
                if (newlineIdx === -1)
                    return;
                const lineOut = chunk.slice(0, newlineIdx).trim();
                if (!lineOut)
                    return;
                try {
                    const msg = JSON.parse(lineOut);
                    clearTimeout(timer);
                    this.proc.stdout.off("data", handler);
                    resolve(msg);
                }
                catch {
                    // continue
                }
            };
            this.proc.stdout.on("data", handler);
            this.proc.stdin.write(`${line}\n`);
        });
    }
    close() {
        this.proc.stdin.end();
        this.proc.kill();
    }
}
async function withClient(fn) {
    const stateRoot = await mkdtemp(join(tmpdir(), "omm-mcp-test-"));
    const client = new McpClient(stateRoot);
    try {
        await fn(client, stateRoot);
    }
    finally {
        client.close();
        await rm(stateRoot, { recursive: true, force: true });
    }
}
async function callTool(client, name, args) {
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
                const result = r.result;
                assert.equal(result.protocolVersion, "2024-11-05");
                const serverInfo = result.serverInfo;
                assert.equal(serverInfo.name, "omm-state");
                assert.equal(serverInfo.version, "0.3.0");
            });
        });
    });
    describe("tools/list", () => {
        it("returns the three omm_state tools", async () => {
            await withClient(async (client) => {
                const r = await client.send("tools/list");
                const result = r.result;
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
                const result = r.result;
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
                const result = r.result;
                const keys = JSON.parse(result.content[0].text);
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
                const r = await client.sendRaw(`{"jsonrpc":"2.0","id":99,"method":"tools/list","params":"${filler}"}`);
                assert.equal(r.error?.code, -32600);
                assert.match(r.error?.message ?? "", /exceeds \d+-byte limit/);
            });
        });
    });
});
//# sourceMappingURL=index.test.js.map