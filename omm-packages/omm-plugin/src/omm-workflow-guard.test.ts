import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertWorkflowExclusivity } from "./omm-workflow-guard.js";

async function withStateDir(
  fn: (stateDir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omm-guard-test-"));
  const stateDir = join(root, "state");
  try {
    await fn(stateDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seed(
  stateDir: string,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, `${key}.json`),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

describe("assertWorkflowExclusivity", () => {
  it("1. allows ralph active=true when state dir is empty", async () => {
    await withStateDir(async (stateDir) => {
      await mkdir(stateDir, { recursive: true });
      const r = await assertWorkflowExclusivity(stateDir, "ralph", {
        mode: "ralph",
        active: true,
      });
      assert.equal(r.ok, true);
    });
  });

  it("2. rejects autopilot active=true when ralph is already active", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "ralph", { mode: "ralph", active: true });
      const r = await assertWorkflowExclusivity(stateDir, "autopilot", {
        mode: "autopilot",
        active: true,
      });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /ralph is already active/);
      assert.equal(r.conflictingMode, "ralph");
    });
  });

  it("3. allows same-mode overwrite when ralph is already active", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "ralph", { mode: "ralph", active: true });
      const r = await assertWorkflowExclusivity(stateDir, "ralph", {
        mode: "ralph",
        active: true,
        iteration: 5,
      });
      assert.equal(r.ok, true);
    });
  });

  it("4. allows autopilot active=false when ralph is active", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "ralph", { mode: "ralph", active: true });
      const r = await assertWorkflowExclusivity(stateDir, "autopilot", {
        mode: "autopilot",
        active: false,
      });
      assert.equal(r.ok, true);
    });
  });

  it("5. allows non-workflow custom key when ralph is active", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "ralph", { mode: "ralph", active: true });
      const r = await assertWorkflowExclusivity(stateDir, "custom-data", {
        active: true,
        foo: "bar",
      });
      assert.equal(r.ok, true);
    });
  });

  it("6. allows ralph activation when team has linked_ralph=true", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "team", {
        mode: "team",
        active: true,
        linked_ralph: true,
      });
      const r = await assertWorkflowExclusivity(stateDir, "ralph", {
        mode: "ralph",
        active: true,
      });
      assert.equal(r.ok, true);
    });
  });

  it("6b. allows team activation with linked_ralph=true when ralph is active", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "ralph", { mode: "ralph", active: true });
      const r = await assertWorkflowExclusivity(stateDir, "team", {
        mode: "team",
        active: true,
        linked_ralph: true,
      });
      assert.equal(r.ok, true);
    });
  });

  it("7. rejects ralph activation when team is active without linked_ralph", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "team", { mode: "team", active: true });
      const r = await assertWorkflowExclusivity(stateDir, "ralph", {
        mode: "ralph",
        active: true,
      });
      assert.equal(r.ok, false);
      assert.equal(r.conflictingMode, "team");
    });
  });

  it("8. allows autopilot activation after ralph terminated (active=false)", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "ralph", {
        mode: "ralph",
        active: false,
        status: "complete",
      });
      const r = await assertWorkflowExclusivity(stateDir, "autopilot", {
        mode: "autopilot",
        active: true,
      });
      assert.equal(r.ok, true);
    });
  });

  it("9. allows write when state dir does not exist (failsafe)", async () => {
    await withStateDir(async (stateDir) => {
      // do NOT create stateDir
      const r = await assertWorkflowExclusivity(stateDir, "ralph", {
        mode: "ralph",
        active: true,
      });
      assert.equal(r.ok, true);
    });
  });

  it("10. skips corrupt JSON files (failsafe)", async () => {
    await withStateDir(async (stateDir) => {
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "broken.json"), "{not json", "utf8");
      const r = await assertWorkflowExclusivity(stateDir, "ralph", {
        mode: "ralph",
        active: true,
      });
      assert.equal(r.ok, true);
    });
  });

  it("11. detects workflow via mode field when key differs", async () => {
    await withStateDir(async (stateDir) => {
      await seed(stateDir, "my-ralph-instance", {
        mode: "ralph",
        active: true,
      });
      const r = await assertWorkflowExclusivity(stateDir, "another-key", {
        mode: "autopilot",
        active: true,
      });
      assert.equal(r.ok, false);
      assert.equal(r.conflictingMode, "ralph");
    });
  });
});
