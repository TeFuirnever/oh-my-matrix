import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateStateWrite } from "./omm-state-validation.js";

const NOW = "2026-04-26T00:00:00.000Z";
const opts = { nowIso: NOW };

describe("validateStateWrite", () => {
  describe("team", () => {
    it("accepts valid active team state with injected defaults", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", active: true, task: "refactor" },
        opts,
      );
      assert.equal(r.ok, true);
      assert.equal(r.state?.current_phase, "planning");
      assert.equal(r.state?.fix_loop_count, 0);
      assert.equal(r.state?.max_fix_loops, 3);
      assert.equal(r.state?.lastUpdatedAt, NOW);
    });

    it("accepts delegating phase", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", active: true, current_phase: "delegating" },
        opts,
      );
      assert.equal(r.ok, true);
    });

    it("rejects complete with active=true", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", active: true, current_phase: "complete" },
        opts,
      );
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes("terminal"));
    });

    it("accepts terminal phase with active=false and stamps completedAt", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", active: false, current_phase: "complete" },
        opts,
      );
      assert.equal(r.ok, true);
      assert.equal(r.state?.completedAt, NOW);
    });

    it("accepts blocked terminal phase with active=false", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", active: false, current_phase: "blocked" },
        opts,
      );
      assert.equal(r.ok, true);
    });

    it("rejects invalid current_phase", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", current_phase: "bogus" },
        opts,
      );
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes("team.current_phase"));
    });

    it("rejects negative fix_loop_count", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", fix_loop_count: -1 },
        opts,
      );
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes("fix_loop_count"));
    });

    it("rejects non-integer fix_loop_count", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", fix_loop_count: 1.5 },
        opts,
      );
      assert.equal(r.ok, false);
    });

    it("rejects zero max_fix_loops", () => {
      const r = validateStateWrite(
        "team",
        { mode: "team", max_fix_loops: 0 },
        opts,
      );
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
      const r = validateStateWrite(
        "custom",
        "not an object" as unknown as Record<string, unknown>,
        opts,
      );
      assert.equal(r.ok, false);
    });

    it("rejects array value", () => {
      const r = validateStateWrite(
        "custom",
        [] as unknown as Record<string, unknown>,
        opts,
      );
      assert.equal(r.ok, false);
    });
  });
});
