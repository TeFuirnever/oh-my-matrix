import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    it("creates an active ralph state with injected defaults", async () => {
        await withTmpRoot(async (root) => {
            const r = await startMode("ralph", { task: "fix bugs" }, { stateRoot: root });
            assert.equal(r.ok, true);
            assert.equal(r.state?.mode, "ralph");
            assert.equal(r.state?.active, true);
            assert.equal(r.state?.status, "init");
            assert.equal(r.state?.iteration, 0);
            assert.equal(r.state?.task, "fix bugs");
            const onDisk = JSON.parse(await readFile(join(root, "state", "ralph.json"), "utf8"));
            assert.equal(onDisk.active, true);
        });
    });
    it("creates an active autopilot state", async () => {
        await withTmpRoot(async (root) => {
            const r = await startMode("autopilot", {}, { stateRoot: root });
            assert.equal(r.ok, true);
            assert.equal(r.state?.status, "analyzing");
            assert.equal(r.state?.current_step, 0);
        });
    });
    it("creates an active team state", async () => {
        await withTmpRoot(async (root) => {
            const r = await startMode("team", { team_name: "fix-bugs" }, { stateRoot: root });
            assert.equal(r.ok, true);
            assert.equal(r.state?.current_phase, "planning");
            assert.equal(r.state?.team_name, "fix-bugs");
        });
    });
    it("rejects when another workflow mode is already active", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", {}, { stateRoot: root });
            const r = await startMode("autopilot", {}, { stateRoot: root });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /ralph is already active/);
        });
    });
    it("allows team with linked_ralph alongside ralph", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", {}, { stateRoot: root });
            const r = await startMode("team", { linked_ralph: true }, { stateRoot: root });
            assert.equal(r.ok, true);
        });
    });
});
describe("updateModeState", () => {
    it("merges patch onto existing active state", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", { task: "x" }, { stateRoot: root });
            const r = await updateModeState("ralph", { iteration: 3, status: "executing" }, { stateRoot: root });
            assert.equal(r.ok, true);
            assert.equal(r.state?.iteration, 3);
            assert.equal(r.state?.status, "executing");
            assert.equal(r.state?.task, "x", "preserves prior fields");
        });
    });
    it("rejects update when mode has no state file", async () => {
        await withTmpRoot(async (root) => {
            const r = await updateModeState("ralph", { iteration: 1 }, { stateRoot: root });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /not found; call startMode/);
        });
    });
    it("rejects update when mode is not active", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", {}, { stateRoot: root });
            await cancelMode("ralph", "done", {
                stateRoot: root,
                kind: "completed",
            });
            const r = await updateModeState("ralph", { iteration: 5 }, { stateRoot: root });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /not active/);
        });
    });
});
describe("cancelMode", () => {
    it("terminates with cancelled outcome by default", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", {}, { stateRoot: root });
            const r = await cancelMode("ralph", "user abort", { stateRoot: root });
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
            await startMode("ralph", {}, { stateRoot: root });
            const r = await cancelMode("ralph", undefined, {
                stateRoot: root,
                kind: "completed",
            });
            assert.equal(r.ok, true);
            assert.equal(r.state?.status, "complete");
            assert.equal(r.state?.active, false);
            assert.ok(r.state?.completedAt);
        });
    });
    it("terminates with failed kind for autopilot", async () => {
        await withTmpRoot(async (root) => {
            await startMode("autopilot", {}, { stateRoot: root });
            const r = await cancelMode("autopilot", "step exhausted", {
                stateRoot: root,
                kind: "failed",
            });
            assert.equal(r.ok, true);
            assert.equal(r.state?.status, "failed");
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
            await startMode("ralph", {}, { stateRoot: root });
            const r = await cancelMode("ralph", "abort", { stateRoot: root });
            assert.equal(r.ok, true);
            // status stays as "init" (whatever it was), only outcome carries cancelled kind
            assert.equal(r.state?.active, false);
            const outcome = r.state?.outcome;
            assert.equal(outcome.kind, "cancelled");
        });
    });
    it("is idempotent on already-terminal state", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", {}, { stateRoot: root });
            const first = await cancelMode("ralph", "first", {
                stateRoot: root,
                kind: "completed",
            });
            assert.equal(first.ok, true);
            const second = await cancelMode("ralph", "second", {
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
            const r = await cancelMode("ralph", "x", { stateRoot: root });
            assert.equal(r.ok, false);
            assert.match(r.error ?? "", /not found/);
        });
    });
});
describe("getModeState", () => {
    it("returns null when no state file exists", async () => {
        await withTmpRoot(async (root) => {
            const s = await getModeState("ralph", { stateRoot: root });
            assert.equal(s, null);
        });
    });
    it("returns the parsed state record after startMode", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", { task: "y" }, { stateRoot: root });
            const s = await getModeState("ralph", { stateRoot: root });
            assert.equal(s?.task, "y");
            assert.equal(s?.active, true);
        });
    });
});
describe("end-to-end mode lifecycle", () => {
    it("ralph: start → update → cancel(completed) full flow", async () => {
        await withTmpRoot(async (root) => {
            const a = await startMode("ralph", { task: "build feature X" }, { stateRoot: root });
            assert.equal(a.ok, true);
            const b = await updateModeState("ralph", { iteration: 1, status: "executing" }, { stateRoot: root });
            assert.equal(b.ok, true);
            assert.equal(b.state?.iteration, 1);
            const c = await updateModeState("ralph", { iteration: 2, status: "verifying" }, { stateRoot: root });
            assert.equal(c.ok, true);
            const d = await cancelMode("ralph", "all stories pass", {
                stateRoot: root,
                kind: "completed",
            });
            assert.equal(d.ok, true);
            assert.equal(d.state?.status, "complete");
            assert.equal(d.state?.iteration, 2, "preserves last iteration count");
            assert.equal(d.state?.task, "build feature X", "preserves task");
            assert.ok(isRunOutcome(d.state?.outcome));
        });
    });
    it("exclusivity holds across the lifecycle: ralph completed → autopilot can start", async () => {
        await withTmpRoot(async (root) => {
            await startMode("ralph", {}, { stateRoot: root });
            await cancelMode("ralph", undefined, {
                stateRoot: root,
                kind: "completed",
            });
            const r = await startMode("autopilot", {}, { stateRoot: root });
            assert.equal(r.ok, true);
        });
    });
});
//# sourceMappingURL=omm-mode-lifecycle.test.js.map