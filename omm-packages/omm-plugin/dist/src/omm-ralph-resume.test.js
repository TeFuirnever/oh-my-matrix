import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cancelMode, startMode } from "./omm-mode-lifecycle.js";
import { appendProgressEntry, getResumePoint, PRD_SCHEMA_VERSION, pendingStories, savePrd, } from "./omm-ralph-store.js";
async function withTmpRoot(fn) {
    const root = await mkdtemp(join(tmpdir(), "omm-ralph-resume-test-"));
    try {
        await fn(root);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}
const samplePrd = {
    version: PRD_SCHEMA_VERSION,
    task: "ship feature",
    stories: [
        { id: "S1", title: "design", criteria: ["spec written"], passes: true },
        { id: "S2", title: "implement", criteria: ["tests pass"], passes: false },
        { id: "S3", title: "verify", criteria: ["lint clean"], passes: false },
    ],
};
describe("getResumePoint", () => {
    it("returns active=false and null fields when nothing exists", async () => {
        await withTmpRoot(async (root) => {
            const r = await getResumePoint(root);
            assert.equal(r.active, false);
            assert.equal(r.modeState, null);
            assert.equal(r.prd, null);
            assert.deepEqual(r.progress, []);
        });
    });
    it("detects active ralph mode without PRD or progress", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", { task: "x" }, { stateRoot: root });
            const r = await getResumePoint(root);
            assert.equal(r.active, true);
            assert.equal(r.modeState?.task, "x");
            assert.equal(r.prd, null);
            assert.deepEqual(r.progress, []);
        });
    });
    it("returns full snapshot: mode + PRD + progress", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", { task: "ship feature" }, { stateRoot: root });
            await savePrd(samplePrd, root);
            await appendProgressEntry({ iteration: 0, summary: "spec drafted" }, root);
            await appendProgressEntry({ iteration: 1, summary: "started impl" }, root);
            const r = await getResumePoint(root);
            assert.equal(r.active, true);
            assert.equal(r.modeState?.task, "ship feature");
            assert.equal(r.prd?.task, "ship feature");
            assert.equal(r.prd?.stories.length, 3);
            assert.equal(r.progress.length, 2);
            assert.equal(r.progress[1].summary, "started impl");
        });
    });
    it("active=false after ralph terminates, but PRD + progress survive", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", {}, { stateRoot: root });
            await savePrd(samplePrd, root);
            await appendProgressEntry({ iteration: 0, summary: "done" }, root);
            await cancelMode("ralph", undefined, {
                stateRoot: root,
                kind: "completed",
            });
            const r = await getResumePoint(root);
            assert.equal(r.active, false);
            assert.equal(r.modeState?.active, false);
            assert.equal(r.prd?.task, "ship feature");
            assert.equal(r.progress.length, 1);
        });
    });
    it("tolerates malformed PRD by treating it as missing", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", {}, { stateRoot: root });
            // Don't write a PRD; getResumePoint should still succeed
            const r = await getResumePoint(root);
            assert.equal(r.active, true);
            assert.equal(r.prd, null);
        });
    });
});
describe("pendingStories", () => {
    it("returns empty array when no PRD", async () => {
        const empty = pendingStories({
            active: false,
            modeState: null,
            prd: null,
            progress: [],
        });
        assert.deepEqual(empty, []);
    });
    it("returns stories with passes=false in declared order", async () => {
        await withTmpRoot(async (root) => {
            await savePrd(samplePrd, root);
            const r = await getResumePoint(root);
            const pending = pendingStories(r);
            assert.equal(pending.length, 2);
            assert.equal(pending[0].id, "S2");
            assert.equal(pending[1].id, "S3");
        });
    });
    it("returns empty when all stories pass", async () => {
        await withTmpRoot(async (root) => {
            await savePrd({
                version: PRD_SCHEMA_VERSION,
                task: "x",
                stories: [
                    { id: "A", title: "a", criteria: [], passes: true },
                    { id: "B", title: "b", criteria: [], passes: true },
                ],
            }, root);
            const r = await getResumePoint(root);
            assert.deepEqual(pendingStories(r), []);
        });
    });
});
//# sourceMappingURL=omm-ralph-resume.test.js.map