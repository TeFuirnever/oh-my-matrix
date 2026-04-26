import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advanceStage,
  getCurrentStage,
  incrementRetry,
  markStageStatus,
  type Stage,
  validatePlan,
} from "./omm-autopilot-pipeline.js";

const samplePlan: Stage[] = [
  { step: 0, description: "analyze", status: "complete", retries: 0 },
  { step: 1, description: "implement", status: "in_progress", retries: 0 },
  { step: 2, description: "verify", status: "pending", retries: 0 },
];

const stateWith = (plan: Stage[], current_step = 1) => ({
  mode: "autopilot",
  active: true,
  plan,
  current_step,
});

describe("validatePlan", () => {
  it("accepts a valid plan", () => {
    assert.equal(validatePlan(samplePlan).ok, true);
  });

  it("accepts empty array", () => {
    assert.equal(validatePlan([]).ok, true);
  });

  it("rejects non-array", () => {
    assert.equal(validatePlan({}).ok, false);
    assert.equal(validatePlan(null).ok, false);
    assert.equal(validatePlan("plan").ok, false);
  });

  it("rejects malformed stage", () => {
    const r = validatePlan([
      { step: "0", description: "x", status: "complete", retries: 0 },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /plan\[0\]/);
  });

  it("rejects unknown status", () => {
    const r = validatePlan([
      { step: 0, description: "x", status: "skipped", retries: 0 },
    ]);
    assert.equal(r.ok, false);
  });

  it("rejects negative step", () => {
    const r = validatePlan([
      { step: -1, description: "x", status: "pending", retries: 0 },
    ]);
    assert.equal(r.ok, false);
  });

  it("rejects negative retries", () => {
    const r = validatePlan([
      { step: 0, description: "x", status: "pending", retries: -1 },
    ]);
    assert.equal(r.ok, false);
  });

  it("rejects duplicate step values", () => {
    const r = validatePlan([
      { step: 0, description: "a", status: "pending", retries: 0 },
      { step: 0, description: "b", status: "pending", retries: 0 },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /duplicate/);
  });

  it("accepts stage with optional summary", () => {
    const r = validatePlan([
      {
        step: 0,
        description: "x",
        status: "complete",
        retries: 0,
        summary: "all good",
      },
    ]);
    assert.equal(r.ok, true);
  });
});

describe("getCurrentStage", () => {
  it("returns the stage at current_step", () => {
    const stage = getCurrentStage(stateWith(samplePlan, 1));
    assert.equal(stage?.step, 1);
    assert.equal(stage?.description, "implement");
  });

  it("returns null when current_step is past the end", () => {
    assert.equal(getCurrentStage(stateWith(samplePlan, 99)), null);
  });

  it("returns null when plan is missing", () => {
    assert.equal(getCurrentStage({ mode: "autopilot", active: true }), null);
  });

  it("returns null when plan is malformed", () => {
    const malformed = stateWith(
      [{ step: 0, description: 1, status: "pending", retries: 0 } as never],
      0,
    );
    assert.equal(getCurrentStage(malformed), null);
  });

  it("defaults to step 0 when current_step missing", () => {
    const stage = getCurrentStage({ plan: samplePlan });
    assert.equal(stage?.step, 0);
  });
});

describe("markStageStatus", () => {
  it("flips one stage's status without touching others", () => {
    const r = markStageStatus(stateWith(samplePlan, 1), 1, "complete");
    assert.equal(r.ok, true);
    const updated = r.patch?.plan as Stage[];
    assert.equal(updated[1].status, "complete");
    assert.equal(updated[0].status, "complete", "preserves stage 0");
    assert.equal(updated[2].status, "pending", "preserves stage 2");
  });

  it("attaches optional summary", () => {
    const r = markStageStatus(
      stateWith(samplePlan, 1),
      1,
      "complete",
      "tests pass",
    );
    const updated = r.patch?.plan as Stage[];
    assert.equal(updated[1].summary, "tests pass");
  });

  it("does not mutate input state", () => {
    const state = stateWith(samplePlan, 1);
    const before = JSON.stringify(state);
    markStageStatus(state, 1, "complete");
    assert.equal(JSON.stringify(state), before);
  });

  it("rejects unknown step", () => {
    const r = markStageStatus(stateWith(samplePlan, 1), 99, "complete");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found/);
  });

  it("rejects invalid status string", () => {
    const r = markStageStatus(stateWith(samplePlan, 1), 1, "bogus" as never);
    assert.equal(r.ok, false);
  });

  it("rejects when plan missing", () => {
    const r = markStageStatus({ mode: "autopilot" }, 0, "complete");
    assert.equal(r.ok, false);
  });
});

describe("incrementRetry", () => {
  it("bumps retries by 1", () => {
    const r = incrementRetry(stateWith(samplePlan, 1), 1);
    assert.equal(r.ok, true);
    const updated = r.patch?.plan as Stage[];
    assert.equal(updated[1].retries, 1);
    assert.equal(updated[0].retries, 0, "preserves other stages");
  });

  it("rejects unknown step", () => {
    const r = incrementRetry(stateWith(samplePlan, 1), 99);
    assert.equal(r.ok, false);
  });

  it("does not enforce a cap (caller owns policy)", () => {
    const high: Stage[] = [
      { step: 0, description: "x", status: "in_progress", retries: 99 },
    ];
    const r = incrementRetry(stateWith(high, 0), 0);
    assert.equal(r.ok, true);
    assert.equal((r.patch?.plan as Stage[])[0].retries, 100);
  });
});

describe("advanceStage", () => {
  it("advances when current stage is complete", () => {
    const plan: Stage[] = [
      { step: 0, description: "a", status: "complete", retries: 0 },
      { step: 1, description: "b", status: "pending", retries: 0 },
    ];
    const r = advanceStage(stateWith(plan, 0));
    assert.equal(r.ok, true);
    assert.equal(r.patch?.current_step, 1);
    const updated = r.patch?.plan as Stage[];
    assert.equal(
      updated[1].status,
      "in_progress",
      "next stage marked in_progress",
    );
  });

  it("refuses to advance when current stage is in_progress", () => {
    const r = advanceStage(stateWith(samplePlan, 1));
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /in_progress/);
  });

  it("refuses to advance when current stage is pending", () => {
    const plan: Stage[] = [
      { step: 0, description: "x", status: "pending", retries: 0 },
    ];
    const r = advanceStage(stateWith(plan, 0));
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /pending/);
  });

  it("refuses to advance when current stage is failed", () => {
    const plan: Stage[] = [
      { step: 0, description: "x", status: "failed", retries: 1 },
    ];
    const r = advanceStage(stateWith(plan, 0));
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /failed/);
  });

  it("advances past the last stage and omits plan patch", () => {
    const plan: Stage[] = [
      { step: 0, description: "only", status: "complete", retries: 0 },
    ];
    const r = advanceStage(stateWith(plan, 0));
    assert.equal(r.ok, true);
    assert.equal(r.patch?.current_step, 1);
    assert.equal(
      r.patch?.plan,
      undefined,
      "no further stage to mark in_progress",
    );
  });

  it("rejects when already past last stage", () => {
    const r = advanceStage(stateWith(samplePlan, 99));
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /past the last stage/);
  });

  it("rejects when plan missing", () => {
    const r = advanceStage({ mode: "autopilot", current_step: 0 });
    assert.equal(r.ok, false);
  });

  it("does not mutate input state", () => {
    const plan: Stage[] = [
      { step: 0, description: "a", status: "complete", retries: 0 },
      { step: 1, description: "b", status: "pending", retries: 0 },
    ];
    const state = stateWith(plan, 0);
    const before = JSON.stringify(state);
    advanceStage(state);
    assert.equal(JSON.stringify(state), before);
  });
});

describe("end-to-end pipeline patches", () => {
  it("full sequence: mark complete → advance → mark complete → advance past last", () => {
    let plan: Stage[] = [
      { step: 0, description: "a", status: "in_progress", retries: 0 },
      { step: 1, description: "b", status: "pending", retries: 0 },
    ];
    let current_step = 0;
    const apply = (patch: Record<string, unknown>): void => {
      if (patch.plan) plan = patch.plan as Stage[];
      if (typeof patch.current_step === "number")
        current_step = patch.current_step;
    };

    // mark stage 0 complete
    const a = markStageStatus({ plan, current_step }, 0, "complete");
    assert.equal(a.ok, true);
    if (a.patch) apply(a.patch);

    // advance to stage 1
    const b = advanceStage({ plan, current_step });
    assert.equal(b.ok, true);
    if (b.patch) apply(b.patch);
    assert.equal(current_step, 1);
    assert.equal(plan[1].status, "in_progress");

    // mark stage 1 complete
    const c = markStageStatus({ plan, current_step }, 1, "complete");
    assert.equal(c.ok, true);
    if (c.patch) apply(c.patch);

    // advance past last stage
    const d = advanceStage({ plan, current_step });
    assert.equal(d.ok, true);
    if (d.patch) apply(d.patch);
    assert.equal(current_step, plan.length);
  });
});
