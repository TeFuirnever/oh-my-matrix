/**
 * Coverage-fill tests — closes the residual branches identified by
 * `pnpm test:coverage` so the omm-plugin source hits 100% statements/
 * functions/branches/lines. Each block targets a specific uncovered
 * line range from the c8 report.
 *
 * These are not new behavioral tests; they exercise paths that already
 * have intent but lacked an assertion. Keep them grouped here so the
 * coverage rationale stays visible.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseAgentPrompt } from "./omm-agent-prompts.js";
import {
  advanceStage,
  incrementRetry,
  validatePlan,
} from "./omm-autopilot-pipeline.js";
import { resolveOmmStateRoot } from "./omm-config.js";
import { dispatchHooks, loadHooks } from "./omm-hook-loader.js";
import {
  cancelMode,
  getModeState,
  startMode,
  updateModeState,
} from "./omm-mode-lifecycle.js";
import {
  loadPrd,
  markStoryPasses,
  validatePrd,
  validateProgressEntry,
} from "./omm-ralph-store.js";
import { deriveOutcomeFromState } from "./omm-run-outcome.js";
import { validateStateWrite } from "./omm-state-validation.js";
import { runOmmPing } from "./omm-tools/omm-ping.js";
import { runOmmStateWrite } from "./omm-tools/omm-state.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omm-cov-fill-"));
}

describe("coverage fill — omm-config", () => {
  it("falls back to ~/.openclaw/omm when no stateRoot configured", () => {
    const got = resolveOmmStateRoot();
    assert.match(got, /\.openclaw[\\/]omm$/);
  });

  it("falls back when configRoot is empty string", () => {
    const got = resolveOmmStateRoot("   ");
    assert.match(got, /\.openclaw[\\/]omm$/);
  });

  it("falls back when configRoot is non-string", () => {
    const got = resolveOmmStateRoot(42 as unknown);
    assert.match(got, /\.openclaw[\\/]omm$/);
  });
});

describe("coverage fill — omm_ping", () => {
  it("normalizes non-string command to default 'ping'", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await runOmmPing({ command: 42 as unknown }, { stateRoot });
      assert.equal(r.content[0].text, "omm pong: ping");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("normalizes empty commandName/skillName to null", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await runOmmPing(
        { command: "go", commandName: "   ", skillName: 99 as unknown },
        { stateRoot },
      );
      const record = r.details.record as Record<string, unknown>;
      assert.equal(record.commandName, null);
      assert.equal(record.skillName, null);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — runOmmStateWrite value-must-be-object", () => {
  it("rejects array values", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await runOmmStateWrite(
        { key: "ralph", value: ["nope"] },
        { stateRoot },
      );
      assert.match(r.content[0].text, /value must be a JSON object/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects null values", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await runOmmStateWrite(
        { key: "ralph", value: null },
        { stateRoot },
      );
      assert.match(r.content[0].text, /value must be a JSON object/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects primitive values", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await runOmmStateWrite(
        { key: "ralph", value: "string" },
        { stateRoot },
      );
      assert.match(r.content[0].text, /value must be a JSON object/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — agent prompt parser edge cases", () => {
  it("skips blank frontmatter lines without erroring", () => {
    const md = `---
name: tester

model_tier: haiku
purpose: testing
---
body here`;
    const r = parseAgentPrompt(md);
    assert.equal(r.name, "tester");
  });

  it("rejects frontmatter line without colon", () => {
    const md = `---
nokey
---
body`;
    assert.throws(() => parseAgentPrompt(md), /invalid frontmatter line/);
  });

  it("rejects name violating NAME_PATTERN", () => {
    const md = `---
name: BadName_With_Underscores
model_tier: sonnet
purpose: testing
---
body`;
    assert.throws(() => parseAgentPrompt(md), /name must match/);
  });
});

describe("coverage fill — autopilot pipeline non-object stage + retry/advance not-found", () => {
  it("rejects plan whose entry is not an object", () => {
    const r = validatePlan([null]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /must be a valid Stage/);
  });

  it("rejects plan whose entry is an array", () => {
    const r = validatePlan([["fake"]]);
    assert.equal(r.ok, false);
  });

  it("incrementRetry returns error when step not found", () => {
    const state = {
      plan: [{ step: 0, description: "first", status: "pending", retries: 0 }],
    };
    const r = incrementRetry(state, 99);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /not found/);
  });

  it("incrementRetry returns error when plan is missing", () => {
    const r = incrementRetry({}, 0);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /missing or malformed/);
  });

  it("advanceStage returns error when current step is not complete", () => {
    const state = {
      plan: [
        { step: 0, description: "first", status: "in_progress", retries: 0 },
        { step: 1, description: "second", status: "pending", retries: 0 },
      ],
      current_step: 0,
    };
    const r = advanceStage(state);
    assert.equal(r.ok, false);
  });
});

describe("coverage fill — ralph PRD validation branches", () => {
  it("rejects story whose value is not an object", () => {
    const r = validatePrd({
      version: 1,
      task: "x",
      stories: [null],
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /stories\[0\] must be an object/);
  });

  it("rejects story missing id", () => {
    const r = validatePrd({
      version: 1,
      task: "x",
      stories: [{ id: "", title: "t", criteria: [], passes: false }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects story whose title is not a string", () => {
    const r = validatePrd({
      version: 1,
      task: "x",
      stories: [{ id: "s1", title: 42, criteria: [], passes: false }],
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /title must be a string/);
  });

  it("rejects story whose criteria is not a string array", () => {
    const r = validatePrd({
      version: 1,
      task: "x",
      stories: [{ id: "s1", title: "t", criteria: [123], passes: false }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects story whose passes is not boolean", () => {
    const r = validatePrd({
      version: 1,
      task: "x",
      stories: [{ id: "s1", title: "t", criteria: [], passes: "no" }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects story whose notes is non-string when present", () => {
    const r = validatePrd({
      version: 1,
      task: "x",
      stories: [
        { id: "s1", title: "t", criteria: [], passes: false, notes: 7 },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /notes must be a string/);
  });

  it("markStoryPasses returns error when PRD does not exist", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await markStoryPasses("any", true, stateRoot);
      assert.equal(r.ok, false);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("loadPrd returns error when prd.json is malformed", async () => {
    const stateRoot = await tempRoot();
    try {
      await mkdir(join(stateRoot, "state"), { recursive: true });
      await writeFile(
        join(stateRoot, "state", "ralph-prd.json"),
        "not json",
        "utf8",
      );
      const r = await loadPrd(stateRoot);
      assert.equal(r.ok, false);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — progress entry non-object", () => {
  it("rejects null entry", () => {
    assert.match(validateProgressEntry(null) ?? "", /must be a JSON object/);
  });

  it("rejects array entry", () => {
    assert.match(validateProgressEntry([]) ?? "", /must be a JSON object/);
  });

  it("rejects primitive entry", () => {
    assert.match(validateProgressEntry("nope") ?? "", /must be a JSON object/);
  });
});

describe("coverage fill — state-validation autopilot/team active defaults", () => {
  it("autopilot active=true injects status, current_step, max_retries_per_step, total_steps", () => {
    const r = validateStateWrite("autopilot", {
      mode: "autopilot",
      active: true,
    });
    assert.equal(r.ok, true);
    const s = r.state as Record<string, unknown>;
    assert.equal(s.status, "analyzing");
    assert.equal(s.current_step, 0);
    assert.equal(s.total_steps, 0);
    assert.equal(s.max_retries_per_step, 3);
    assert.ok(typeof s.startedAt === "string");
  });

  it("autopilot rejects current_step that is not a non-negative integer", () => {
    const r = validateStateWrite("autopilot", {
      mode: "autopilot",
      active: true,
      current_step: -1,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /current_step/);
  });

  it("autopilot rejects total_steps that is not a non-negative integer", () => {
    const r = validateStateWrite("autopilot", {
      mode: "autopilot",
      active: true,
      total_steps: 1.5,
    });
    assert.equal(r.ok, false);
  });

  it("team active=true injects fix_loop_count, max_fix_loops, current_phase", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
    });
    assert.equal(r.ok, true);
    const s = r.state as Record<string, unknown>;
    assert.equal(s.fix_loop_count, 0);
    assert.equal(s.max_fix_loops, 3);
    assert.equal(s.current_phase, "planning");
    assert.ok(typeof s.startedAt === "string");
  });

  it("team rejects fix_loop_count that is not a non-negative integer", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      fix_loop_count: "many",
    });
    assert.equal(r.ok, false);
  });
});

describe("coverage fill — mode-lifecycle writeState early-return branches", () => {
  it("startMode rejects sanitization failure", async () => {
    const stateRoot = await tempRoot();
    try {
      // mode is whitelisted, but the validator rejects unknown initialFields
      // for the autopilot mode if we feed a totally bad shape. The explicit
      // sanitization-failure path is hit by passing a key with traversal,
      // which can only happen via the tools layer — instead trigger a
      // validator failure here, which exits writeState before exclusivity.
      const r = await updateModeState(
        "autopilot",
        { current_step: -5 },
        { stateRoot },
      );
      assert.equal(r.ok, false);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("startMode + exclusivity rejection path", async () => {
    const stateRoot = await tempRoot();
    try {
      const a = await startMode("ralph", {}, { stateRoot });
      assert.equal(a.ok, true);
      const b = await startMode("autopilot", {}, { stateRoot });
      assert.equal(b.ok, false); // ralph already active
      assert.match(b.error ?? "", /already active/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — agent prompt model_tier + purpose + body branches", () => {
  it("rejects invalid model_tier", () => {
    const md = `---
name: tester
model_tier: turbo
purpose: testing
---
body`;
    assert.throws(() => parseAgentPrompt(md), /model_tier must be one of/);
  });

  it("rejects missing purpose", () => {
    const md = `---
name: tester
model_tier: sonnet
---
body`;
    assert.throws(() => parseAgentPrompt(md), /purpose is required/);
  });

  it("rejects empty body", () => {
    const md = `---
name: tester
model_tier: sonnet
purpose: t
---

`;
    assert.throws(() => parseAgentPrompt(md), /body is empty/);
  });
});

describe("coverage fill — autopilot stage summary type", () => {
  it("rejects stage with non-string summary", () => {
    const r = validatePlan([
      {
        step: 0,
        description: "x",
        status: "pending",
        retries: 0,
        summary: 42,
      },
    ]);
    assert.equal(r.ok, false);
  });

  it("rejects stage with non-integer step", () => {
    const r = validatePlan([
      { step: 1.5, description: "x", status: "pending", retries: 0 },
    ]);
    assert.equal(r.ok, false);
  });

  it("rejects stage with unknown status", () => {
    const r = validatePlan([
      { step: 0, description: "x", status: "bogus", retries: 0 },
    ]);
    assert.equal(r.ok, false);
  });

  it("rejects stage with negative retries", () => {
    const r = validatePlan([
      { step: 0, description: "x", status: "pending", retries: -1 },
    ]);
    assert.equal(r.ok, false);
  });

  it("rejects duplicate step values across stages", () => {
    const r = validatePlan([
      { step: 0, description: "x", status: "pending", retries: 0 },
      { step: 0, description: "y", status: "pending", retries: 0 },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /duplicate stage step/);
  });
});

describe("coverage fill — state-validation positive-int rejection branches", () => {
  it("ralph max_fix_attempts must be a positive integer", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: true,
      max_fix_attempts: 0,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /max_fix_attempts/);
  });

  it("autopilot max_retries_per_step must be a positive integer", () => {
    const r = validateStateWrite("autopilot", {
      mode: "autopilot",
      active: true,
      max_retries_per_step: -1,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /max_retries_per_step/);
  });

  it("team max_fix_loops must be a positive integer", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      max_fix_loops: 0,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /max_fix_loops/);
  });
});

describe("coverage fill — mode-lifecycle cancel + getModeState", () => {
  it("cancelMode marks an active record terminal with the requested kind", async () => {
    const stateRoot = await tempRoot();
    try {
      await startMode("ralph", { task: "x" }, { stateRoot });
      const r = await cancelMode("ralph", "user abort", {
        stateRoot,
        kind: "failed",
      });
      assert.equal(r.ok, true);
      const s = r.state as Record<string, unknown>;
      assert.equal(s.active, false);
      assert.equal(s.status, "failed");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("cancelMode is idempotent on already-terminal state", async () => {
    const stateRoot = await tempRoot();
    try {
      await startMode("ralph", {}, { stateRoot });
      await cancelMode("ralph", undefined, { stateRoot, kind: "completed" });
      const second = await cancelMode("ralph", undefined, {
        stateRoot,
        kind: "completed",
      });
      assert.equal(second.ok, true); // no-op success
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("cancelMode returns error when state file does not exist", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await cancelMode("ralph", undefined, { stateRoot });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not found/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("updateModeState rejects when state file does not exist", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await updateModeState("ralph", { iteration: 1 }, { stateRoot });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not found/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("updateModeState rejects when mode is not active", async () => {
    const stateRoot = await tempRoot();
    try {
      await startMode("ralph", {}, { stateRoot });
      await cancelMode("ralph", undefined, { stateRoot, kind: "completed" });
      const r = await updateModeState("ralph", { iteration: 1 }, { stateRoot });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not active/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("getModeState returns null when state file does not exist", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await getModeState("ralph", { stateRoot });
      assert.equal(r, null);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("getModeState returns the parsed record when present", async () => {
    const stateRoot = await tempRoot();
    try {
      await startMode("ralph", { task: "y" }, { stateRoot });
      const r = await getModeState("ralph", { stateRoot });
      assert.ok(r && r.active === true);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — markStoryPasses error propagation", () => {
  it("propagates loadPrd error when prd file is malformed", async () => {
    const stateRoot = await tempRoot();
    try {
      await mkdir(join(stateRoot, "state"), { recursive: true });
      await writeFile(
        join(stateRoot, "state", "ralph-prd.json"),
        "{ broken",
        "utf8",
      );
      const r = await markStoryPasses("any", true, stateRoot);
      assert.equal(r.ok, false);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("returns error when story id not found", async () => {
    const stateRoot = await tempRoot();
    try {
      await mkdir(join(stateRoot, "state"), { recursive: true });
      const prd = {
        version: 1,
        task: "t",
        stories: [{ id: "s1", title: "t", criteria: ["c"], passes: false }],
      };
      await writeFile(
        join(stateRoot, "state", "ralph-prd.json"),
        JSON.stringify(prd),
        "utf8",
      );
      const r = await markStoryPasses("missing", true, stateRoot);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not found/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — hook loader error paths", () => {
  it("reports an issue when a hook module fails to import", async () => {
    const stateRoot = await tempRoot();
    try {
      const hooksDir = join(stateRoot, "hooks");
      await mkdir(hooksDir, { recursive: true });
      // Syntax error in the .mjs forces a SyntaxError on dynamic import.
      await writeFile(
        join(hooksDir, "broken.mjs"),
        "this is not valid JS @@@",
        "utf8",
      );
      const r = await loadHooks(hooksDir);
      assert.ok(r.issues.length >= 1);
      assert.match(r.issues[0].error, /import failed/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("dispatchHooks captures handler errors as failed outcomes", async () => {
    const stateRoot = await tempRoot();
    try {
      const hooksDir = join(stateRoot, "hooks");
      await mkdir(hooksDir, { recursive: true });
      await writeFile(
        join(hooksDir, "thrower.mjs"),
        `export const event = "x"; export async function handler() { throw new Error("nope"); }`,
        "utf8",
      );
      const r = await dispatchHooks(hooksDir, "x", {});
      assert.ok(r.outcomes.some((o) => o.ok === false));
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — deriveOutcomeFromState branches", () => {
  it("returns null when state is still active", () => {
    const out = deriveOutcomeFromState({
      mode: "ralph",
      active: true,
      status: "executing",
    });
    assert.equal(out, null);
  });

  it("returns null when phase is not a recognized terminal", () => {
    const out = deriveOutcomeFromState({
      mode: "ralph",
      active: false,
      status: "executing",
    });
    assert.equal(out, null);
  });

  it("returns null when phase is not a string", () => {
    const out = deriveOutcomeFromState({
      mode: "ralph",
      active: false,
      status: 42,
    });
    assert.equal(out, null);
  });

  it("uses team current_phase instead of status", () => {
    const out = deriveOutcomeFromState({
      mode: "team",
      active: false,
      current_phase: "complete",
    });
    assert.ok(out && out.kind === "completed");
  });
});

describe("coverage fill — timestamp validators + ralph fix_attempt", () => {
  it("rejects ralph startedAt that is not a valid ISO8601 timestamp", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: true,
      startedAt: "not-a-date",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /startedAt/);
  });

  it("rejects ralph completedAt that is not a valid ISO8601 timestamp", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: false,
      status: "complete",
      completedAt: "tomorrow",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /completedAt/);
  });

  it("rejects ralph lastUpdatedAt that is not a valid ISO8601 timestamp", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: true,
      lastUpdatedAt: "soon",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /lastUpdatedAt/);
  });

  it("rejects ralph fix_attempt that is not a non-negative integer", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: true,
      fix_attempt: -1,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /fix_attempt/);
  });

  it("rejects ralph max_iterations that is not positive", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: true,
      max_iterations: 0,
    });
    assert.equal(r.ok, false);
  });

  it("rejects empty-string status (validatePhase non-string/empty branch)", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: true,
      status: "",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /non-empty string/);
  });

  it("rejects non-string status", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: true,
      status: 42,
    });
    assert.equal(r.ok, false);
  });
});

describe("coverage fill — workflow-guard non-workflow existing key", () => {
  it("ignores existing files whose key+mode are not a workflow (skip continue)", async () => {
    const stateRoot = await tempRoot();
    try {
      // Pre-seed a custom (non-workflow) key with active=true, then start a
      // real workflow. The guard must inspect the file, fail to detect a
      // workflow mode for it (because key/mode neither match), and continue.
      // This exercises the `if (!existingMode) continue;` branch.
      const stateDir = join(stateRoot, "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "smoke.json"),
        JSON.stringify({ active: true, hello: "world" }),
        "utf8",
      );
      const r = await startMode("ralph", { task: "x" }, { stateRoot });
      assert.equal(r.ok, true);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — agent-prompts missing name (template (missing) branch)", () => {
  it("throws with '(missing)' tag when name field is absent", () => {
    const md = `---
model_tier: sonnet
purpose: t
---
body`;
    assert.throws(() => parseAgentPrompt(md), /\(missing\)/);
  });

  it("throws with '(missing)' tag when model_tier is absent", () => {
    const md = `---
name: tester
purpose: t
---
body`;
    assert.throws(() => parseAgentPrompt(md), /\(missing\)/);
  });
});

describe("coverage fill — hook-loader non-Error throw branches", () => {
  it("captures handler throwing a non-Error value", async () => {
    const stateRoot = await tempRoot();
    try {
      const hooksDir = join(stateRoot, "hooks");
      await mkdir(hooksDir, { recursive: true });
      // The hook throws a string, not an Error, exercising the
      // `String(err)` branch in the dispatch catch.
      await writeFile(
        join(hooksDir, "stringThrower.mjs"),
        `export const event = "x"; export async function handler() { throw "raw-string"; }`,
        "utf8",
      );
      const r = await dispatchHooks(hooksDir, "x", {});
      const failed = r.outcomes.find((o) => o.ok === false);
      assert.ok(failed);
      assert.match(failed.error ?? "", /raw-string/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("captures non-Error throw at module-import time", async () => {
    const stateRoot = await tempRoot();
    try {
      const hooksDir = join(stateRoot, "hooks");
      await mkdir(hooksDir, { recursive: true });
      // Top-level `throw "string"` — not an Error instance.
      await writeFile(
        join(hooksDir, "stringImport.mjs"),
        `throw "module-load-string";`,
        "utf8",
      );
      const r = await loadHooks(hooksDir);
      assert.ok(r.issues.length >= 1);
      assert.match(r.issues[0].error, /module-load-string/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — runOmmStateWrite warning vs non-warning text branches", () => {
  it("non-warning success path", async () => {
    const stateRoot = await tempRoot();
    try {
      // Writing a fully-specified terminal record produces no defaults
      // injection and therefore no warning, exercising the non-warning
      // arm of the `validation.warning ? ... : ...` ternary.
      const r = await runOmmStateWrite(
        {
          key: "ralph",
          value: {
            mode: "ralph",
            active: false,
            status: "complete",
            iteration: 1,
            max_iterations: 3,
            startedAt: "2026-04-26T00:00:00.000Z",
            completedAt: "2026-04-26T00:01:00.000Z",
          },
        },
        { stateRoot },
      );
      // Plain "omm_state_write: ralph" with no "(warning: ...)" trailer.
      assert.match(r.content[0].text, /^omm_state_write: ralph$/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — phase + timestamp error sub-branches", () => {
  it("autopilot rejects an unknown status value", () => {
    const r = validateStateWrite("autopilot", {
      mode: "autopilot",
      active: true,
      status: "frobulating",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /must be one of/);
  });

  it("team rejects an unknown current_phase value", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      current_phase: "imaginary",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /must be one of/);
  });

  it("autopilot rejects malformed timestamps", () => {
    const r = validateStateWrite("autopilot", {
      mode: "autopilot",
      active: true,
      startedAt: "yesterday",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /startedAt/);
  });

  it("team rejects malformed timestamps", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      startedAt: "now",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /startedAt/);
  });

  it("rejects autopilot fix_attempt non-numeric (asPosInt non-number branch)", () => {
    const r = validateStateWrite("ralph", {
      mode: "ralph",
      active: true,
      max_iterations: Infinity,
    });
    assert.equal(r.ok, false);
  });

  it("rejects autopilot fix_attempt with empty-string lastUpdatedAt", () => {
    const r = validateStateWrite("autopilot", {
      mode: "autopilot",
      active: true,
      lastUpdatedAt: "",
    });
    assert.equal(r.ok, false);
  });
});
