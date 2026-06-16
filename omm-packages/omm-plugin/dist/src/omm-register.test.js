/**
 * omm-register integration tests — exercise the OpenClaw runtime call shape.
 *
 * These tests catch a class of bug where `execute: (params) => ...` looks
 * right but actually receives the toolCallId string in `params`, because
 * OpenClaw calls `execute(toolCallId, params, signal, onUpdate)`. A 1-arg
 * declaration silently captures the id and ignores everything else.
 *
 * The bug shipped in 0.2.1 — every `params.field` access returned undefined,
 * and `omm_state_read({key:"x"})` failed with `"key is required"` because
 * the sanitizer saw a string toolCallId instead of an args object.
 *
 * These tests invoke each registered tool's `execute` with the real 4-arg
 * runtime shape and assert that the params reach the underlying handler.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { register } from "./omm-register.js";
async function registerWithTempRoot() {
    const stateRoot = await mkdtemp(join(tmpdir(), "omm-register-test-"));
    const tools = {};
    register({
        registerTool: (tool) => {
            tools[tool.name] = tool;
        },
        config: { stateRoot },
    });
    return {
        tools,
        stateRoot,
        cleanup: () => rm(stateRoot, { recursive: true, force: true }),
    };
}
describe("omm-register: 4-arg execute(toolCallId, params, signal, onUpdate)", () => {
    it("registers exactly the 5 team-focused tools", async () => {
        const { tools, cleanup } = await registerWithTempRoot();
        try {
            assert.ok(tools.omm_state_write);
            assert.ok(tools.omm_state_read);
            assert.ok(tools.omm_employee_list);
            assert.ok(tools.omm_employee_dispatch);
            assert.ok(tools.omm_employee_result);
            // Removed tools must NOT be registered (v0.5 surface reduction).
            assert.equal(tools.omm_state_list, undefined);
            assert.equal(tools.omm_agent_prompt_get, undefined);
            assert.equal(tools.omm_agent_prompt_list, undefined);
        }
        finally {
            await cleanup();
        }
    });
    it("omm_state_read receives params at arg2, returns 'null' for missing key", async () => {
        const { tools, cleanup } = await registerWithTempRoot();
        try {
            // Real OpenClaw call shape — toolCallId first, params second.
            const result = (await tools.omm_state_read.execute("call-id-abc123", { key: "doesnotexist" }, undefined, () => undefined));
            // Bug regression guard: would return "key is required" if the
            // signature regressed to (params) and captured the toolCallId.
            assert.equal(result.content[0].text, "null", `expected "null" for missing key, got: ${result.content[0].text}`);
        }
        finally {
            await cleanup();
        }
    });
    it("omm_state_write writes params and is round-trip readable", async () => {
        const { tools, stateRoot, cleanup } = await registerWithTempRoot();
        try {
            const writeResult = (await tools.omm_state_write.execute("call-id-write", {
                key: "team",
                value: { mode: "team", active: false, current_phase: "complete" },
            }, undefined, () => undefined));
            assert.match(writeResult.content[0].text, /omm_state_write: team/);
            // Verify the file actually exists at the expected path.
            const onDisk = await readFile(join(stateRoot, "state", "team.json"), "utf8");
            assert.match(onDisk, /"mode": "team"/);
            // Round-trip via omm_state_read.
            const readResult = (await tools.omm_state_read.execute("call-id-read", { key: "team" }, undefined, () => undefined));
            assert.match(readResult.content[0].text, /"mode": "team"/);
        }
        finally {
            await cleanup();
        }
    });
    it("execute remains tolerant when signal/onUpdate are omitted", async () => {
        const { tools, cleanup } = await registerWithTempRoot();
        try {
            // Some runtime call sites (the HTTP gateway) pass only (id, params).
            const result = (await tools.omm_state_read.execute("id3", {
                key: "absent",
            }));
            assert.equal(result.content[0].text, "null");
        }
        finally {
            await cleanup();
        }
    });
});
//# sourceMappingURL=omm-register.test.js.map