import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  dispatchOmmHooks,
  handleModeChange,
  handlePostToolUse,
  handlePreToolUse,
  handleSessionEnd,
  handleSessionStart,
} from "./omm-hooks.js";

describe("omm-hooks event sources", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "omm-hooks-test-"));
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("dispatchOmmHooks returns null when no hooks dir exists", async () => {
    const outcome = await dispatchOmmHooks(
      "session_start",
      { sessionId: "s1" },
      { stateRoot },
    );
    // Either null or an empty outcomes array — both mean "no hooks ran"
    if (outcome !== null) {
      assert.equal(outcome.outcomes.length, 0);
    }
  });

  it("dispatchOmmHooks loads and runs a user hook", async () => {
    const dir = join(stateRoot, "hooks", "post_tool_use");
    await mkdir(dir, { recursive: true });
    const hookPath = join(dir, "audit.mjs");
    const sentinelPath = join(stateRoot, "hook-fired.txt");
    await writeFile(
      hookPath,
      `export const event = "post_tool_use";
       import { writeFileSync } from "node:fs";
       export async function handler(args) {
         writeFileSync(${JSON.stringify(sentinelPath)}, JSON.stringify(args));
       }`,
      "utf8",
    );
    const outcome = await dispatchOmmHooks(
      "post_tool_use",
      { toolName: "omm_ping", durationMs: 5 },
      { stateRoot },
    );
    assert.ok(outcome);
    assert.equal(outcome.outcomes.length, 1);
    assert.equal(outcome.outcomes[0].ok, true);
    const { readFileSync } = await import("node:fs");
    const fired = JSON.parse(readFileSync(sentinelPath, "utf8"));
    assert.equal(fired.toolName, "omm_ping");
    assert.equal(fired.durationMs, 5);
  });

  it("dispatchOmmHooks swallows handler errors (other hooks still run)", async () => {
    const dir = join(stateRoot, "hooks", "pre_tool_use");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "thrower.mjs"),
      `export const event = "pre_tool_use";
       export async function handler() { throw new Error("boom"); }`,
      "utf8",
    );
    await writeFile(
      join(dir, "ok.mjs"),
      `export const event = "pre_tool_use";
       export async function handler() { return "ok"; }`,
      "utf8",
    );
    const outcome = await dispatchOmmHooks("pre_tool_use", {}, { stateRoot });
    assert.ok(outcome);
    assert.equal(outcome.outcomes.length, 2);
    const errors = outcome.outcomes.filter((r) => r.ok === false);
    const successes = outcome.outcomes.filter((r) => r.ok === true);
    assert.equal(errors.length, 1);
    assert.equal(successes.length, 1);
  });

  it("handleSessionStart writes session record AND dispatches hooks", async () => {
    const dir = join(stateRoot, "hooks", "session_start");
    await mkdir(dir, { recursive: true });
    const sentinelPath = join(stateRoot, "started.txt");
    await writeFile(
      join(dir, "logger.mjs"),
      `export const event = "session_start";
       import { writeFileSync } from "node:fs";
       export async function handler(args) {
         writeFileSync(${JSON.stringify(sentinelPath)}, args.sessionId ?? "");
       }`,
      "utf8",
    );
    await handleSessionStart({ sessionId: "s42" }, { stateRoot });

    const { readFileSync, existsSync } = await import("node:fs");
    assert.ok(existsSync(join(stateRoot, "state", "session.json")));
    assert.equal(readFileSync(sentinelPath, "utf8"), "s42");
  });

  it("handleSessionEnd silently survives missing state dir", async () => {
    const sentinelPath = join(stateRoot, "ended.txt");
    const dir = join(stateRoot, "hooks", "session_end");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "logger.mjs"),
      `export const event = "session_end";
       import { writeFileSync } from "node:fs";
       export async function handler() {
         writeFileSync(${JSON.stringify(sentinelPath)}, "fired");
       }`,
      "utf8",
    );
    await handleSessionEnd({}, { stateRoot });
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(sentinelPath, "utf8"), "fired");
  });

  it("handlePreToolUse / handlePostToolUse / handleModeChange dispatch their respective events", async () => {
    const events = ["pre_tool_use", "post_tool_use", "mode_change"] as const;
    for (const ev of events) {
      const dir = join(stateRoot, "hooks", ev);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "h.mjs"),
        `export const event = "${ev}";
         import { writeFileSync } from "node:fs";
         export async function handler() {
           writeFileSync(${JSON.stringify(join(stateRoot, `${ev}.txt`))}, "ok");
         }`,
        "utf8",
      );
    }
    await handlePreToolUse({ toolName: "x" }, { stateRoot });
    await handlePostToolUse({ toolName: "x" }, { stateRoot });
    await handleModeChange({ mode: "ralph" }, { stateRoot });
    const { existsSync } = await import("node:fs");
    for (const ev of events) {
      assert.ok(existsSync(join(stateRoot, `${ev}.txt`)), `${ev} fired`);
    }
  });

  it("dispatchOmmHooks survives a corrupt hook module (load error)", async () => {
    const dir = join(stateRoot, "hooks", "pre_tool_use");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "bad.mjs"),
      `this is not valid javascript {{{`,
      "utf8",
    );
    const outcome = await dispatchOmmHooks("pre_tool_use", {}, { stateRoot });
    // Either returns null (suppressed) or an outcome with no successful runs
    if (outcome !== null) {
      assert.equal(outcome.outcomes.length, 0);
      assert.ok(outcome.issues.length >= 1, "issue must be reported");
    }
  });
});
