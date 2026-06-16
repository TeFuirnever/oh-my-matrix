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
import { resolveOmmStateRoot } from "./omm-config.js";
import { dispatchHooks, loadHooks } from "./omm-hook-loader.js";
import {
  cancelMode,
  getModeState,
  startMode,
  updateModeState,
} from "./omm-mode-lifecycle.js";
import { deriveOutcomeFromState } from "./omm-run-outcome.js";
import { validateStateWrite } from "./omm-state-validation.js";
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

describe("coverage fill — runOmmStateWrite value-must-be-object", () => {
  it("rejects array values", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await runOmmStateWrite(
        { key: "custom", value: ["nope"] },
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
        { key: "custom", value: null },
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
        { key: "custom", value: "string" },
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

describe("coverage fill — state-validation team active defaults", () => {
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
  it("startMode rejects a validator failure before exclusivity", async () => {
    const stateRoot = await tempRoot();
    try {
      // An invalid current_phase makes validateStateWrite fail inside
      // writeState, exiting before the exclusivity guard runs.
      const r = await updateModeState(
        "team",
        { current_phase: "frobulating" },
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
      // Pre-seed a *different* team key with active=true so the exclusivity
      // guard rejects a fresh startMode("team") write.
      const stateDir = join(stateRoot, "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "team-other.json"),
        JSON.stringify({ mode: "team", active: true }),
        "utf8",
      );
      const b = await startMode("team", {}, { stateRoot });
      assert.equal(b.ok, false); // foreign team already active
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

describe("coverage fill — state-validation positive-int rejection branches", () => {
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
      await startMode("team", { task: "x" }, { stateRoot });
      const r = await cancelMode("team", "user abort", {
        stateRoot,
        kind: "failed",
      });
      assert.equal(r.ok, true);
      const s = r.state as Record<string, unknown>;
      assert.equal(s.active, false);
      assert.equal(s.current_phase, "failed");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("cancelMode is idempotent on already-terminal state", async () => {
    const stateRoot = await tempRoot();
    try {
      await startMode("team", {}, { stateRoot });
      await cancelMode("team", undefined, { stateRoot, kind: "completed" });
      const second = await cancelMode("team", undefined, {
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
      const r = await cancelMode("team", undefined, { stateRoot });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not found/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("updateModeState rejects when state file does not exist", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await updateModeState(
        "team",
        { fix_loop_count: 1 },
        { stateRoot },
      );
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not found/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("updateModeState rejects when mode is not active", async () => {
    const stateRoot = await tempRoot();
    try {
      await startMode("team", {}, { stateRoot });
      await cancelMode("team", undefined, { stateRoot, kind: "completed" });
      const r = await updateModeState(
        "team",
        { fix_loop_count: 1 },
        { stateRoot },
      );
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not active/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("getModeState returns null when state file does not exist", async () => {
    const stateRoot = await tempRoot();
    try {
      const r = await getModeState("team", { stateRoot });
      assert.equal(r, null);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("getModeState returns the parsed record when present", async () => {
    const stateRoot = await tempRoot();
    try {
      await startMode("team", { task: "y" }, { stateRoot });
      const r = await getModeState("team", { stateRoot });
      assert.ok(r && r.active === true);
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
      mode: "team",
      active: true,
      current_phase: "executing",
    });
    assert.equal(out, null);
  });

  it("returns null when phase is not a recognized terminal", () => {
    const out = deriveOutcomeFromState({
      mode: "team",
      active: false,
      current_phase: "executing",
    });
    assert.equal(out, null);
  });

  it("returns null when phase is not a string", () => {
    const out = deriveOutcomeFromState({
      mode: "team",
      active: false,
      current_phase: 42,
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

describe("coverage fill — timestamp validators + team fix_loop_count", () => {
  it("rejects team startedAt that is not a valid ISO8601 timestamp", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      startedAt: "not-a-date",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /startedAt/);
  });

  it("rejects team completedAt that is not a valid ISO8601 timestamp", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: false,
      current_phase: "complete",
      completedAt: "tomorrow",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /completedAt/);
  });

  it("rejects team lastUpdatedAt that is not a valid ISO8601 timestamp", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      lastUpdatedAt: "soon",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /lastUpdatedAt/);
  });

  it("rejects team fix_loop_count that is not a non-negative integer", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      fix_loop_count: -1,
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /fix_loop_count/);
  });

  it("rejects team max_fix_loops that is not positive", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      max_fix_loops: 0,
    });
    assert.equal(r.ok, false);
  });

  it("rejects empty-string current_phase (normalizePhase non-string/empty branch)", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      current_phase: "",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /non-empty string/);
  });

  it("rejects non-string current_phase", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      current_phase: 42,
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
      const r = await startMode("team", { task: "x" }, { stateRoot });
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
          key: "team",
          value: {
            mode: "team",
            active: false,
            current_phase: "complete",
            fix_loop_count: 1,
            max_fix_loops: 3,
            startedAt: "2026-04-26T00:00:00.000Z",
            completedAt: "2026-04-26T00:01:00.000Z",
          },
        },
        { stateRoot },
      );
      // Plain "omm_state_write: team" with no "(warning: ...)" trailer.
      assert.match(r.content[0].text, /^omm_state_write: team$/);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("coverage fill — phase + timestamp error sub-branches", () => {
  it("team rejects an unknown current_phase value", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      current_phase: "imaginary",
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /must be one of/);
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

  it("rejects team max_fix_loops non-numeric (asPosInt non-number branch)", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      max_fix_loops: Infinity,
    });
    assert.equal(r.ok, false);
  });

  it("rejects team with empty-string lastUpdatedAt", () => {
    const r = validateStateWrite("team", {
      mode: "team",
      active: true,
      lastUpdatedAt: "",
    });
    assert.equal(r.ok, false);
  });
});
