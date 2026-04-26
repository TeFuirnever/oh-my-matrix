import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateStateWrite } from "./omm-state-validation.js";
const NOW = "2026-04-26T00:00:00.000Z";
const opts = { nowIso: NOW };
describe("validateStateWrite", () => {
    describe("ralph", () => {
        it("accepts valid active ralph state", () => {
            const r = validateStateWrite("ralph", { mode: "ralph", active: true, task: "fix bug" }, opts);
            assert.equal(r.ok, true);
            assert.equal(r.state?.status, "init");
            assert.equal(r.state?.iteration, 0);
            assert.equal(r.state?.lastUpdatedAt, NOW);
        });
        it("rejects invalid status", () => {
            const r = validateStateWrite("ralph", { mode: "ralph", status: "bogus" }, opts);
            assert.equal(r.ok, false);
            assert.ok(r.error?.includes("ralph.status"));
        });
        it("rejects terminal phase with active=true", () => {
            const r = validateStateWrite("ralph", { mode: "ralph", active: true, status: "complete" }, opts);
            assert.equal(r.ok, false);
            assert.ok(r.error?.includes("terminal"));
        });
        it("accepts terminal phase with active=false", () => {
            const r = validateStateWrite("ralph", { mode: "ralph", active: false, status: "complete" }, opts);
            assert.equal(r.ok, true);
            assert.equal(r.state?.completedAt, NOW);
        });
        it("rejects negative iteration", () => {
            const r = validateStateWrite("ralph", { mode: "ralph", iteration: -1 }, opts);
            assert.equal(r.ok, false);
            assert.ok(r.error?.includes("iteration"));
        });
        it("rejects non-integer iteration", () => {
            const r = validateStateWrite("ralph", { mode: "ralph", iteration: 1.5 }, opts);
            assert.equal(r.ok, false);
        });
        it("rejects zero max_iterations", () => {
            const r = validateStateWrite("ralph", { mode: "ralph", max_iterations: 0 }, opts);
            assert.equal(r.ok, false);
        });
    });
    describe("autopilot", () => {
        it("accepts valid active autopilot state", () => {
            const r = validateStateWrite("autopilot", { mode: "autopilot", active: true, goal: "deploy" }, opts);
            assert.equal(r.ok, true);
            assert.equal(r.state?.status, "analyzing");
            assert.equal(r.state?.current_step, 0);
        });
        it("rejects blocked with active=true", () => {
            const r = validateStateWrite("autopilot", { mode: "autopilot", active: true, status: "blocked" }, opts);
            assert.equal(r.ok, false);
        });
        it("accepts blocked with active=false", () => {
            const r = validateStateWrite("autopilot", { mode: "autopilot", active: false, status: "blocked" }, opts);
            assert.equal(r.ok, true);
        });
    });
    describe("team", () => {
        it("accepts valid active team state", () => {
            const r = validateStateWrite("team", { mode: "team", active: true, task: "refactor" }, opts);
            assert.equal(r.ok, true);
            assert.equal(r.state?.current_phase, "planning");
            assert.equal(r.state?.fix_loop_count, 0);
        });
        it("accepts delegating phase", () => {
            const r = validateStateWrite("team", { mode: "team", active: true, current_phase: "delegating" }, opts);
            assert.equal(r.ok, true);
        });
        it("rejects complete with active=true", () => {
            const r = validateStateWrite("team", { mode: "team", active: true, current_phase: "complete" }, opts);
            assert.equal(r.ok, false);
        });
    });
    describe("unknown keys", () => {
        it("passes through unknown keys with timestamp", () => {
            const r = validateStateWrite("custom", { foo: "bar" }, opts);
            assert.equal(r.ok, true);
            assert.equal(r.state?.foo, "bar");
            assert.equal(r.state?.lastUpdatedAt, NOW);
        });
    });
    describe("invalid input", () => {
        it("rejects non-object value", () => {
            const r = validateStateWrite("ralph", "not an object", opts);
            assert.equal(r.ok, false);
        });
        it("rejects array value", () => {
            const r = validateStateWrite("ralph", [], opts);
            assert.equal(r.ok, false);
        });
    });
});
//# sourceMappingURL=omm-state-validation.test.js.map