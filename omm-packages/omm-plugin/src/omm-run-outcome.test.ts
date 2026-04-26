import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveOutcomeFromState,
  isRunOutcome,
  makeRunOutcome,
  outcomeKindToPhase,
  phaseToOutcomeKind,
} from "./omm-run-outcome.js";

describe("phaseToOutcomeKind", () => {
  it("maps each terminal phase to its outcome kind", () => {
    assert.equal(phaseToOutcomeKind("complete"), "completed");
    assert.equal(phaseToOutcomeKind("failed"), "failed");
    assert.equal(phaseToOutcomeKind("blocked"), "blocked");
    assert.equal(phaseToOutcomeKind("cancelled"), "cancelled");
  });

  it("normalizes case and whitespace", () => {
    assert.equal(phaseToOutcomeKind("  COMPLETE "), "completed");
    assert.equal(phaseToOutcomeKind("Failed"), "failed");
  });

  it("returns null for non-terminal phases", () => {
    assert.equal(phaseToOutcomeKind("init"), null);
    assert.equal(phaseToOutcomeKind("planning"), null);
    assert.equal(phaseToOutcomeKind("executing"), null);
    assert.equal(phaseToOutcomeKind("verifying"), null);
    assert.equal(phaseToOutcomeKind(""), null);
    assert.equal(phaseToOutcomeKind("garbage"), null);
  });
});

describe("outcomeKindToPhase", () => {
  it("is the inverse of phaseToOutcomeKind for terminal phases", () => {
    for (const k of ["completed", "failed", "blocked", "cancelled"] as const) {
      assert.equal(phaseToOutcomeKind(outcomeKindToPhase(k)), k);
    }
  });
});

describe("makeRunOutcome", () => {
  it("constructs a valid outcome with auto-timestamp", () => {
    const o = makeRunOutcome({ kind: "completed", mode: "ralph" });
    assert.equal(o.kind, "completed");
    assert.equal(o.mode, "ralph");
    assert.equal(o.reason, undefined);
    assert.ok(Number.isFinite(Date.parse(o.finishedAt)));
  });

  it("preserves reason when provided", () => {
    const o = makeRunOutcome({
      kind: "blocked",
      mode: "autopilot",
      reason: "step 3 retries exhausted",
    });
    assert.equal(o.reason, "step 3 retries exhausted");
  });

  it("preserves explicit finishedAt", () => {
    const o = makeRunOutcome({
      kind: "failed",
      mode: "team",
      finishedAt: "2026-04-26T12:00:00.000Z",
    });
    assert.equal(o.finishedAt, "2026-04-26T12:00:00.000Z");
  });

  it("rejects invalid kind", () => {
    assert.throws(
      () =>
        makeRunOutcome({
          kind: "bogus" as never,
          mode: "ralph",
        }),
      /invalid RunOutcome kind/,
    );
  });

  it("rejects invalid mode", () => {
    assert.throws(
      () =>
        makeRunOutcome({
          kind: "completed",
          mode: "swarm" as never,
        }),
      /invalid RunOutcome mode/,
    );
  });

  it("rejects invalid finishedAt", () => {
    assert.throws(
      () =>
        makeRunOutcome({
          kind: "completed",
          mode: "ralph",
          finishedAt: "not a date",
        }),
      /finishedAt must be a valid ISO8601 timestamp/,
    );
  });

  it("rejects non-string reason", () => {
    assert.throws(
      () =>
        makeRunOutcome({
          kind: "failed",
          mode: "ralph",
          reason: 42 as never,
        }),
      /reason must be a string/,
    );
  });
});

describe("isRunOutcome", () => {
  it("accepts a structurally-valid outcome", () => {
    const o = makeRunOutcome({ kind: "completed", mode: "ralph" });
    assert.equal(isRunOutcome(o), true);
  });

  it("rejects null and primitives", () => {
    assert.equal(isRunOutcome(null), false);
    assert.equal(isRunOutcome(undefined), false);
    assert.equal(isRunOutcome("completed"), false);
    assert.equal(isRunOutcome(42), false);
  });

  it("rejects missing or wrong-typed fields", () => {
    assert.equal(isRunOutcome({}), false);
    assert.equal(
      isRunOutcome({ kind: "completed", mode: "ralph" }),
      false,
      "missing finishedAt",
    );
    assert.equal(
      isRunOutcome({
        kind: "completed",
        mode: "ralph",
        finishedAt: "garbage",
      }),
      false,
    );
    assert.equal(
      isRunOutcome({
        kind: "bogus",
        mode: "ralph",
        finishedAt: new Date().toISOString(),
      }),
      false,
    );
    assert.equal(
      isRunOutcome({
        kind: "completed",
        mode: "swarm",
        finishedAt: new Date().toISOString(),
      }),
      false,
    );
    assert.equal(
      isRunOutcome({
        kind: "completed",
        mode: "ralph",
        finishedAt: new Date().toISOString(),
        reason: 1,
      }),
      false,
    );
  });
});

describe("deriveOutcomeFromState", () => {
  it("derives completed outcome from ralph terminal state", () => {
    const o = deriveOutcomeFromState({
      mode: "ralph",
      active: false,
      status: "complete",
      completedAt: "2026-04-26T10:00:00.000Z",
    });
    assert.ok(o);
    assert.equal(o?.kind, "completed");
    assert.equal(o?.mode, "ralph");
    assert.equal(o?.finishedAt, "2026-04-26T10:00:00.000Z");
  });

  it("derives failed outcome from autopilot terminal state", () => {
    const o = deriveOutcomeFromState({
      mode: "autopilot",
      active: false,
      status: "failed",
      completedAt: "2026-04-26T10:00:00.000Z",
    });
    assert.equal(o?.kind, "failed");
    assert.equal(o?.mode, "autopilot");
  });

  it("derives blocked outcome from autopilot blocked state", () => {
    const o = deriveOutcomeFromState({
      mode: "autopilot",
      active: false,
      status: "blocked",
      completedAt: "2026-04-26T10:00:00.000Z",
    });
    assert.equal(o?.kind, "blocked");
  });

  it("derives outcome from team using current_phase, not status", () => {
    const o = deriveOutcomeFromState({
      mode: "team",
      active: false,
      current_phase: "complete",
      completedAt: "2026-04-26T10:00:00.000Z",
    });
    assert.equal(o?.kind, "completed");
    assert.equal(o?.mode, "team");
  });

  it("returns null for active=true (still running)", () => {
    const o = deriveOutcomeFromState({
      mode: "ralph",
      active: true,
      status: "executing",
    });
    assert.equal(o, null);
  });

  it("returns null for non-terminal phase even with active=false", () => {
    const o = deriveOutcomeFromState({
      mode: "ralph",
      active: false,
      status: "executing",
    });
    assert.equal(o, null);
  });

  it("returns null for unknown mode", () => {
    const o = deriveOutcomeFromState({
      mode: "swarm",
      active: false,
      status: "complete",
    });
    assert.equal(o, null);
  });

  it("returns null when phase field is missing", () => {
    const o = deriveOutcomeFromState({ mode: "ralph", active: false });
    assert.equal(o, null);
  });

  it("falls back to current time when completedAt missing", () => {
    const before = Date.now();
    const o = deriveOutcomeFromState({
      mode: "ralph",
      active: false,
      status: "complete",
    });
    const after = Date.now();
    assert.ok(o);
    const ts = Date.parse(o?.finishedAt ?? "");
    assert.ok(ts >= before && ts <= after);
  });
});
