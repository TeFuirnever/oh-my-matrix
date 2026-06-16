import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runOmmEmployeeDispatch, runOmmEmployeeList, runOmmEmployeeResult, runOmmEmployeeResultBatch, } from "./omm-employee.js";
async function withTmpDir(fn) {
    const dir = join(tmpdir(), `omm-employee-test-${Math.random().toString(36).slice(2, 10)}`);
    await mkdir(dir, { recursive: true });
    try {
        await fn(dir);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
async function writeJson(path, data) {
    await writeFile(path, `${JSON.stringify(data)}\n`, "utf8");
}
describe("runOmmEmployeeList", () => {
    it("returns empty list when no cache file exists", async () => {
        await withTmpDir(async (dir) => {
            const result = await runOmmEmployeeList({}, { stateRoot: dir });
            const payload = JSON.parse(result.content[0].text);
            assert.deepEqual(payload, { employees: [] });
            assert.equal(result.details.cached, false);
        });
    });
    it("returns employees from a valid cache", async () => {
        await withTmpDir(async (dir) => {
            const stateDir = join(dir, "state");
            await mkdir(stateDir, { recursive: true });
            const cache = {
                employees: [
                    { agentId: "a1", roleId: "r1", status: "active" },
                    { agentId: "a2", roleId: "r2", status: "idle" },
                ],
                generatedAt: 1718500000000,
            };
            await writeJson(join(stateDir, "ma-employees.json"), cache);
            const result = await runOmmEmployeeList({}, { stateRoot: dir });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.employees.length, 2);
            assert.equal(payload.employees[0].agentId, "a1");
            assert.equal(result.details.cached, true);
        });
    });
    it("returns empty list when cache has empty employees array", async () => {
        await withTmpDir(async (dir) => {
            const stateDir = join(dir, "state");
            await mkdir(stateDir, { recursive: true });
            await writeJson(join(stateDir, "ma-employees.json"), {
                employees: [],
                generatedAt: 1,
            });
            const result = await runOmmEmployeeList({}, { stateRoot: dir });
            const payload = JSON.parse(result.content[0].text);
            assert.deepEqual(payload, { employees: [] });
        });
    });
});
describe("runOmmEmployeeDispatch", () => {
    it("dispatches a task and returns a runId", async () => {
        await withTmpDir(async (dir) => {
            const result = await runOmmEmployeeDispatch({ agentId: "test-agent", message: "do the thing" }, { stateRoot: dir });
            const payload = JSON.parse(result.content[0].text);
            assert.ok(typeof payload.runId === "string");
            assert.ok(payload.runId.length > 0);
            assert.equal(payload.status, "dispatched");
            assert.equal(result.details.status, "dispatched");
            // Verify the dispatch file was written atomically
            const requestPath = join(dir, "state", "dispatch", `${payload.runId}.json`);
            const raw = await readFile(requestPath, "utf8");
            const request = JSON.parse(raw);
            assert.equal(request.agentId, "test-agent");
            assert.equal(request.message, "do the thing");
            assert.equal(request.status, "pending");
            assert.equal(request.sessionKey, "agent:test-agent:main");
            assert.equal(typeof request.createdAt, "number");
        });
    });
    it("produces unique runIds for concurrent dispatches", async () => {
        await withTmpDir(async (dir) => {
            const a = await runOmmEmployeeDispatch({ agentId: "a", message: "x" }, { stateRoot: dir });
            const b = await runOmmEmployeeDispatch({ agentId: "b", message: "y" }, { stateRoot: dir });
            const idA = JSON.parse(a.content[0].text).runId;
            const idB = JSON.parse(b.content[0].text).runId;
            assert.notEqual(idA, idB);
        });
    });
    it("returns error when agentId is missing", async () => {
        await withTmpDir(async (dir) => {
            const result = await runOmmEmployeeDispatch({ message: "do it" }, { stateRoot: dir });
            assert.ok(result.content[0].text.includes("error"));
            assert.ok(result.content[0].text.includes("agentId"));
            assert.equal(result.details.code, "OMM_E_VALUE_MISSING");
        });
    });
    it("returns error when message is missing", async () => {
        await withTmpDir(async (dir) => {
            const result = await runOmmEmployeeDispatch({ agentId: "a" }, { stateRoot: dir });
            assert.ok(result.content[0].text.includes("error"));
            assert.ok(result.content[0].text.includes("message"));
        });
    });
});
describe("runOmmEmployeeResult", () => {
    it("returns the result when the .result.json is already present", async () => {
        await withTmpDir(async (dir) => {
            const runId = "test-run-1";
            const dispatchDir = join(dir, "state", "dispatch");
            await mkdir(dispatchDir, { recursive: true });
            // Write request and result ahead of time
            await writeJson(join(dispatchDir, `${runId}.json`), {
                runId,
                status: "pending",
            });
            await writeJson(join(dispatchDir, `${runId}.result.json`), {
                runId,
                result: { text: "all done" },
                completedAt: 1718500000000,
            });
            const result = await runOmmEmployeeResult({ runId }, { stateRoot: dir });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.status, "complete");
            assert.deepEqual(payload.output, { text: "all done" });
        });
    });
    it("returns error when runId is missing", async () => {
        await withTmpDir(async (dir) => {
            const result = await runOmmEmployeeResult({}, { stateRoot: dir });
            assert.ok(result.content[0].text.includes("error"));
            assert.ok(result.content[0].text.includes("runId"));
        });
    });
    it("returns expired error when neither request nor result exists", async () => {
        await withTmpDir(async (dir) => {
            const result = await runOmmEmployeeResult({ runId: "no-such-dispatch" }, { stateRoot: dir });
            assert.ok(result.content[0].text.includes("expired"));
            assert.equal(result.details.code, "OMM_E_DISPATCH_TIMEOUT");
        });
    });
});
describe("runOmmEmployeeResultBatch", () => {
    it("collects results for multiple runIds concurrently", async () => {
        await withTmpDir(async (dir) => {
            const dispatchDir = join(dir, "state", "dispatch");
            await mkdir(dispatchDir, { recursive: true });
            const runId1 = "batch-run-1";
            const runId2 = "batch-run-2";
            // Pre-write requests and results so polls resolve immediately
            await writeJson(join(dispatchDir, `${runId1}.json`), {
                runId: runId1,
                status: "pending",
            });
            await writeJson(join(dispatchDir, `${runId1}.result.json`), {
                runId: runId1,
                result: { text: "done-1" },
                completedAt: 1718500000001,
            });
            await writeJson(join(dispatchDir, `${runId2}.json`), {
                runId: runId2,
                status: "pending",
            });
            await writeJson(join(dispatchDir, `${runId2}.result.json`), {
                runId: runId2,
                result: { text: "done-2" },
                completedAt: 1718500000002,
            });
            const result = await runOmmEmployeeResultBatch({ runIds: [runId1, runId2] }, { stateRoot: dir });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.results.length, 2);
            assert.equal(payload.count, 2);
            const statuses = payload.results
                .map((r) => r.status)
                .sort();
            assert.deepEqual(statuses, ["complete", "complete"]);
        });
    });
    it("reports timeout status for missing results without throwing", async () => {
        await withTmpDir(async (dir) => {
            const dispatchDir = join(dir, "state", "dispatch");
            await mkdir(dispatchDir, { recursive: true });
            const runId = "batch-timeout";
            // Write the request but never the result → poll loop hits "expired"
            await writeJson(join(dispatchDir, `${runId}.json`), {
                runId,
                status: "pending",
            });
            const result = await runOmmEmployeeResultBatch({ runIds: [runId] }, { stateRoot: dir });
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].status, "timeout");
        });
    });
    it("rejects empty runIds array", async () => {
        await withTmpDir(async (dir) => {
            const result = await runOmmEmployeeResultBatch({ runIds: [] }, { stateRoot: dir });
            assert.ok(result.content[0].text.includes("error"));
            assert.equal(result.details.code, "OMM_E_VALUE_INVALID");
        });
    });
    it("rejects non-array runIds", async () => {
        await withTmpDir(async (dir) => {
            const result = await runOmmEmployeeResultBatch({ runIds: "not-an-array" }, { stateRoot: dir });
            assert.ok(result.content[0].text.includes("error"));
            assert.equal(result.details.code, "OMM_E_VALUE_INVALID");
        });
    });
});
//# sourceMappingURL=omm-employee.test.js.map