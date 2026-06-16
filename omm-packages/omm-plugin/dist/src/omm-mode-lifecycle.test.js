import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cancelMode, getModeState, startMode, updateModeState, } from "./omm-mode-lifecycle.js";
import { isRunOutcome } from "./omm-run-outcome.js";
async function withTmpRoot(fn) {
    const root = await mkdtemp(join(tmpdir(), "omm-lifecycle-test-"));
    try {
        await fn(root);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}
describe("startMode", () => {
    it("creates an active team state with injected defaults", async () => {
        await withTmpRoot(async (root) => {
            const r = await startMode("team", { task: "fix bugs" }, { stateRoot: root });
            assert.equal(r.ok, true);
            assert.equal(r.state?.mode, "team");
            assert.equal(r.state?.active, true);
            assert.equal(r.state?.current_phase, "planning");
            assert.equal(r.state?.fix_loop_count, 0);
            assert.equal(r.state?.max_fix_loops, 3);
            assert.equal(r.state?.task, "fix bugs");
            const onDisk = JSON.parse(await readFile(join(root, "state", "team.json"), "utf8"));
            assert.equal(onDisk.active, true);
        });
    });
    it("allows a same-key team overwrite (re-start) when team is already active", async () => {
        await withTmpRoot(async (root) => {
            const a = await startMode("team", { task: "first" }, { stateRoot: root });
            assert.equal(a.ok, true);
            // Same key overwrite is permitted by the exclusivity guard.
            const b = await startMode("team", { task: "second" }, { stateRoot: root });
            assert.equal(b.ok, true);
        });
    });
    it("rejects startMode that fails validation", async () => {
        await withTmpRoot(async (root) => {
            // An invalid current_phase value makes validateStateWrite fail inside
            // startMode before exclusivity, exercising the early-return branch.
            const r = await startMode("team", { current_phase: "frobulating" }, { stateRoot: root });
            assert.equal(r.ok, false);
        });
    });
});
describe("updateModeState", () => {
    it("merges patch onto existing active state", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", { task: "x" }, { stateRoot: root });
            const r = await updateModeState("team", { fix_loop_count: 3, current_phase: "executing" }, { stateRoot: root });
            assert.equal(r.ok, true);
            assert.equal(r.state?.fix_loop_count, 3);
            assert.equal(r.state?.current_phase, "executing");
            assert.equal(r.state?.task, "x", "preserves prior fields");
        });
    });
    it("rejects update when mode has no state file", async () => {
        await withTmpRoot(async (root) => {
            const r = await updateModeState("team", { fix_loop_count: 1 }, { stateRoot: root });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /not found; call startMode/);
        });
    });
    it("rejects update when mode is not active", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", {}, { stateRoot: root });
            await cancelMode("team", "done", {
                stateRoot: root,
                kind: "completed",
            });
            const r = await updateModeState("team", { fix_loop_count: 5 }, { stateRoot: root });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /not active/);
        });
    });
    it("rejects update when the merged record fails validation", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", { task: "x" }, { stateRoot: root });
            const r = await updateModeState("team", { current_phase: "frobulating" }, { stateRoot: root });
            assert.equal(r.ok, false);
        });
    });
});
describe("cancelMode", () => {
    it("terminates with cancelled outcome by default", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", {}, { stateRoot: root });
            const r = await cancelMode("team", "user abort", { stateRoot: root });
            assert.equal(r.ok, true);
            assert.equal(r.state?.active, false);
            assert.ok(isRunOutcome(r.state?.outcome));
            const outcome = r.state?.outcome;
            assert.equal(outcome.kind, "cancelled");
            assert.equal(outcome.reason, "user abort");
        });
    });
    it("terminates with completed kind and stamps phase=complete", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", {}, { stateRoot: root });
            const r = await cancelMode("team", undefined, {
                stateRoot: root,
                kind: "completed",
            });
            assert.equal(r.ok, true);
            assert.equal(r.state?.current_phase, "complete");
            assert.equal(r.state?.active, false);
            assert.ok(r.state?.completedAt);
        });
    });
    it("terminates with failed kind and stamps phase=failed", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", {}, { stateRoot: root });
            const r = await cancelMode("team", "loop exhausted", {
                stateRoot: root,
                kind: "failed",
            });
            assert.equal(r.ok, true);
            assert.equal(r.state?.current_phase, "failed");
        });
    });
    it("terminates team with current_phase, not status", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", {}, { stateRoot: root });
            const r = await cancelMode("team", undefined, {
                stateRoot: root,
                kind: "completed",
            });
            assert.equal(r.ok, true);
            assert.equal(r.state?.current_phase, "complete");
        });
    });
    it("does not stamp phase for cancelled (validator does not accept it)", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", {}, { stateRoot: root });
            const r = await cancelMode("team", "abort", { stateRoot: root });
            assert.equal(r.ok, true);
            // current_phase stays as the prior value (planning from start),
            // only the outcome record carries the cancelled kind.
            assert.equal(r.state?.active, false);
            const outcome = r.state?.outcome;
            assert.equal(outcome.kind, "cancelled");
        });
    });
    it("is idempotent on already-terminal state", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", {}, { stateRoot: root });
            const first = await cancelMode("team", "first", {
                stateRoot: root,
                kind: "completed",
            });
            assert.equal(first.ok, true);
            const second = await cancelMode("team", "second", {
                stateRoot: root,
                kind: "completed",
            });
            assert.equal(second.ok, true);
            // Idempotent: existing terminal state is returned unchanged.
            // The second reason is discarded; first cancel's outcome is preserved.
            const outcome = second.state?.outcome;
            assert.equal(outcome?.reason, "first");
        });
    });
    it("returns error when mode has no state file", async () => {
        await withTmpRoot(async (root) => {
            const r = await cancelMode("team", "x", { stateRoot: root });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /not found/);
        });
    });
});
describe("getModeState", () => {
    it("returns null when no state file exists", async () => {
        await withTmpRoot(async (root) => {
            const s = await getModeState("team", { stateRoot: root });
            assert.equal(s, null);
        });
    });
    it("returns the parsed state record after startMode", async () => {
        await withTmpRoot(async (root) => {
            await startMode("team", { task: "y" }, { stateRoot: root });
            const s = await getModeState("team", { stateRoot: root });
            assert.equal(s?.task, "y");
            assert.equal(s?.active, true);
        });
    });
});
describe("end-to-end mode lifecycle", () => {
    it("team: start → update → cancel(completed) full flow", async () => {
        await withTmpRoot(async (root) => {
            const a = await startMode("team", { task: "build feature X" }, { stateRoot: root });
            assert.equal(a.ok, true);
            const b = await updateModeState("team", { fix_loop_count: 1, current_phase: "executing" }, { stateRoot: root });
            assert.equal(b.ok, true);
            assert.equal(b.state?.fix_loop_count, 1);
            const c = await updateModeState("team", { fix_loop_count: 2, current_phase: "verifying" }, { stateRoot: root });
            assert.equal(c.ok, true);
            const d = await cancelMode("team", "all stories pass", {
                stateRoot: root,
                kind: "completed",
            });
            assert.equal(d.ok, true);
            assert.equal(d.state?.current_phase, "complete");
            assert.equal(d.state?.fix_loop_count, 2, "preserves last fix_loop_count");
            assert.equal(d.state?.task, "build feature X", "preserves task");
            assert.ok(isRunOutcome(d.state?.outcome));
        });
    });
    it("exclusivity holds: a foreign active team file blocks a new team start", async () => {
        await withTmpRoot(async (root) => {
            // Pre-seed a *different* key with an active team record, simulating a
            // concurrent workflow under a different team key. The exclusivity guard
            // detects the workflow via the mode field and rejects the new start.
            const stateDir = join(root, "state");
            await mkdir(stateDir, { recursive: true });
            await writeFile(join(stateDir, "team-other.json"), JSON.stringify({ mode: "team", active: true }), "utf8");
            // startMode writes the "team" key; the guard sees the pre-existing
            // "team-other" active record and rejects.
            const r = await startMode("team", {}, { stateRoot: root });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /team is already active/);
        });
    });
});
//# sourceMappingURL=omm-mode-lifecycle.test.js.map