import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertWorkflowExclusivity } from "./omm-workflow-guard.js";
async function withStateDir(fn) {
    const root = await mkdtemp(join(tmpdir(), "omm-guard-test-"));
    const stateDir = join(root, "state");
    try {
        await fn(stateDir);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}
async function seed(stateDir, key, value) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, `${key}.json`), JSON.stringify(value, null, 2), "utf8");
}
describe("assertWorkflowExclusivity", () => {
    it("1. allows team active=true when state dir is empty", async () => {
        await withStateDir(async (stateDir) => {
            await mkdir(stateDir, { recursive: true });
            const r = await assertWorkflowExclusivity(stateDir, "team", {
                mode: "team",
                active: true,
            });
            assert.equal(r.ok, true);
        });
    });
    it("2. rejects a second team active=true under a different key when team is already active", async () => {
        await withStateDir(async (stateDir) => {
            await seed(stateDir, "team", { mode: "team", active: true });
            const r = await assertWorkflowExclusivity(stateDir, "team-other", {
                mode: "team",
                active: true,
            });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /team is already active/);
            assert.equal(r.conflictingMode, "team");
        });
    });
    it("3. allows same-key overwrite when team is already active", async () => {
        await withStateDir(async (stateDir) => {
            await seed(stateDir, "team", { mode: "team", active: true });
            const r = await assertWorkflowExclusivity(stateDir, "team", {
                mode: "team",
                active: true,
                fix_loop_count: 5,
            });
            assert.equal(r.ok, true);
        });
    });
    it("4. allows team active=false when another team is active", async () => {
        await withStateDir(async (stateDir) => {
            await seed(stateDir, "team", { mode: "team", active: true });
            const r = await assertWorkflowExclusivity(stateDir, "team-other", {
                mode: "team",
                active: false,
            });
            assert.equal(r.ok, true);
        });
    });
    it("5. allows non-workflow custom key when team is active", async () => {
        await withStateDir(async (stateDir) => {
            await seed(stateDir, "team", { mode: "team", active: true });
            const r = await assertWorkflowExclusivity(stateDir, "custom-data", {
                active: true,
                foo: "bar",
            });
            assert.equal(r.ok, true);
        });
    });
    it("6. allows team activation after a previous team terminated (active=false)", async () => {
        await withStateDir(async (stateDir) => {
            await seed(stateDir, "team", {
                mode: "team",
                active: false,
                current_phase: "complete",
            });
            const r = await assertWorkflowExclusivity(stateDir, "team", {
                mode: "team",
                active: true,
            });
            assert.equal(r.ok, true);
        });
    });
    it("7. allows write when state dir does not exist (failsafe)", async () => {
        await withStateDir(async (stateDir) => {
            // do NOT create stateDir
            const r = await assertWorkflowExclusivity(stateDir, "team", {
                mode: "team",
                active: true,
            });
            assert.equal(r.ok, true);
        });
    });
    it("8. skips corrupt JSON files (failsafe)", async () => {
        await withStateDir(async (stateDir) => {
            await mkdir(stateDir, { recursive: true });
            await writeFile(join(stateDir, "broken.json"), "{not json", "utf8");
            const r = await assertWorkflowExclusivity(stateDir, "team", {
                mode: "team",
                active: true,
            });
            assert.equal(r.ok, true);
        });
    });
    it("9. detects workflow via mode field when key differs", async () => {
        await withStateDir(async (stateDir) => {
            await seed(stateDir, "my-team-instance", {
                mode: "team",
                active: true,
            });
            const r = await assertWorkflowExclusivity(stateDir, "another-key", {
                mode: "team",
                active: true,
            });
            assert.equal(r.ok, false);
            assert.equal(r.conflictingMode, "team");
        });
    });
    it("10. ignores a non-workflow file whose mode is not a workflow mode", async () => {
        await withStateDir(async (stateDir) => {
            // A custom key with active=true but a non-workflow mode field.
            await seed(stateDir, "legacy-ralph", {
                mode: "ralph",
                active: true,
            });
            const r = await assertWorkflowExclusivity(stateDir, "team", {
                mode: "team",
                active: true,
            });
            assert.equal(r.ok, true);
        });
    });
});
//# sourceMappingURL=omm-workflow-guard.test.js.map