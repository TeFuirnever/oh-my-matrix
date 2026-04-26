import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { dispatchHooks, loadHooks } from "./omm-hook-loader.js";
async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "omm-hooks-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const validHookSource = (event, body = "args.called = true;") => `
export const event = "${event}";
export const handler = async (args) => {
  ${body}
  return args;
};
`;
describe("loadHooks", () => {
  it("returns empty list when dir does not exist", async () => {
    await withTmpDir(async (dir) => {
      const r = await loadHooks(join(dir, "nonexistent"));
      assert.deepEqual(r.hooks, []);
      assert.deepEqual(r.issues, []);
    });
  });
  it("loads a valid hook", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "good.mjs"),
        validHookSource("session_start"),
        "utf8",
      );
      const r = await loadHooks(dir);
      assert.equal(r.hooks.length, 1);
      assert.equal(r.hooks[0].event, "session_start");
      assert.deepEqual(r.issues, []);
    });
  });
  it("filters by event name when provided", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "start.mjs"),
        validHookSource("session_start"),
        "utf8",
      );
      await writeFile(
        join(dir, "end.mjs"),
        validHookSource("session_end"),
        "utf8",
      );
      const r = await loadHooks(dir, "session_start");
      assert.equal(r.hooks.length, 1);
      assert.equal(r.hooks[0].event, "session_start");
    });
  });
  it("loads multiple hooks for the same event", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "a.mjs"), validHookSource("ev"), "utf8");
      await writeFile(join(dir, "b.mjs"), validHookSource("ev"), "utf8");
      const r = await loadHooks(dir, "ev");
      assert.equal(r.hooks.length, 2);
    });
  });
  it("ignores non-mjs files", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "good.mjs"), validHookSource("ev"), "utf8");
      await writeFile(join(dir, "README.txt"), "not a hook", "utf8");
      await writeFile(join(dir, "skip.js"), "// not loaded", "utf8");
      const r = await loadHooks(dir);
      assert.equal(r.hooks.length, 1);
    });
  });
  it("ignores hidden files", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, ".hidden.mjs"), validHookSource("ev"), "utf8");
      await writeFile(join(dir, "visible.mjs"), validHookSource("ev"), "utf8");
      const r = await loadHooks(dir);
      assert.equal(r.hooks.length, 1);
    });
  });
  it("reports issue when event export is missing", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "bad.mjs"),
        "export const handler = () => {};",
        "utf8",
      );
      const r = await loadHooks(dir);
      assert.equal(r.hooks.length, 0);
      assert.equal(r.issues.length, 1);
      assert.match(r.issues[0].error, /event/);
    });
  });
  it("reports issue when handler export is missing", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "bad.mjs"),
        'export const event = "ev";',
        "utf8",
      );
      const r = await loadHooks(dir);
      assert.equal(r.issues.length, 1);
      assert.match(r.issues[0].error, /handler/);
    });
  });
  it("reports issue when module fails to import", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "syntax-error.mjs"),
        "this is not valid javascript {{{",
        "utf8",
      );
      const r = await loadHooks(dir);
      assert.equal(r.hooks.length, 0);
      assert.equal(r.issues.length, 1);
      assert.match(r.issues[0].error, /import failed/);
    });
  });
});
describe("dispatchHooks", () => {
  it("runs all matching hooks and captures values", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "h1.mjs"),
        `
export const event = "ev";
export const handler = async () => 1;
`,
        "utf8",
      );
      await writeFile(
        join(dir, "h2.mjs"),
        `
export const event = "ev";
export const handler = async () => 2;
`,
        "utf8",
      );
      const r = await dispatchHooks(dir, "ev", {});
      assert.equal(r.outcomes.length, 2);
      assert.ok(r.outcomes.every((o) => o.ok));
      const values = r.outcomes.map((o) => o.value).sort();
      assert.deepEqual(values, [1, 2]);
    });
  });
  it("captures errors per-hook without stopping others", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "throws.mjs"),
        `
export const event = "ev";
export const handler = async () => { throw new Error("boom"); };
`,
        "utf8",
      );
      await writeFile(
        join(dir, "ok.mjs"),
        `
export const event = "ev";
export const handler = async () => "good";
`,
        "utf8",
      );
      const r = await dispatchHooks(dir, "ev", {});
      assert.equal(r.outcomes.length, 2);
      const failed = r.outcomes.find((o) => !o.ok);
      const succeeded = r.outcomes.find((o) => o.ok);
      assert.ok(failed);
      assert.match(failed?.error ?? "", /boom/);
      assert.equal(succeeded?.value, "good");
    });
  });
  it("does not run hooks for other events", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "ev.mjs"),
        validHookSource("session_start"),
        "utf8",
      );
      const r = await dispatchHooks(dir, "session_end", {});
      assert.deepEqual(r.outcomes, []);
    });
  });
  it("returns empty outcomes when dir is missing", async () => {
    await withTmpDir(async (dir) => {
      const r = await dispatchHooks(join(dir, "nope"), "ev", {});
      assert.deepEqual(r.outcomes, []);
      assert.deepEqual(r.issues, []);
    });
  });
  it("passes args through to handlers", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "echo.mjs"),
        `
export const event = "ev";
export const handler = async (args) => args.payload;
`,
        "utf8",
      );
      const r = await dispatchHooks(dir, "ev", { payload: "hello" });
      assert.equal(r.outcomes[0].value, "hello");
    });
  });
  it("supports synchronous handlers", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, "sync.mjs"),
        `
export const event = "ev";
export const handler = (args) => args.x * 2;
`,
        "utf8",
      );
      const r = await dispatchHooks(dir, "ev", { x: 21 });
      assert.equal(r.outcomes[0].value, 42);
    });
  });
});
//# sourceMappingURL=omm-hook-loader.test.js.map
