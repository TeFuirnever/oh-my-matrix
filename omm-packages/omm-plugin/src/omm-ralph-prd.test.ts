import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  loadPrd,
  markStoryPasses,
  PRD_FILENAME,
  PRD_SCHEMA_VERSION,
  type RalphPrd,
  savePrd,
  validatePrd,
} from "./omm-ralph-prd.js";

async function withTmpRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omm-ralph-prd-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const minimalPrd: RalphPrd = {
  version: PRD_SCHEMA_VERSION,
  task: "fix all lint errors",
  stories: [
    {
      id: "US-1",
      title: "Fix auth module",
      criteria: ["pnpm lint passes for src/auth/"],
      passes: false,
    },
  ],
};

describe("validatePrd", () => {
  it("accepts a minimal valid PRD", () => {
    assert.equal(validatePrd(minimalPrd).ok, true);
  });

  it("rejects non-object input", () => {
    assert.equal(validatePrd(null).ok, false);
    assert.equal(validatePrd("string").ok, false);
    assert.equal(validatePrd([]).ok, false);
  });

  it("rejects PRD with top-level mode field (workflow guard collision)", () => {
    const r = validatePrd({ ...minimalPrd, mode: "ralph" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /mode/);
  });

  it("rejects bad version", () => {
    assert.equal(validatePrd({ ...minimalPrd, version: 0 }).ok, false);
    assert.equal(validatePrd({ ...minimalPrd, version: -1 }).ok, false);
    assert.equal(validatePrd({ ...minimalPrd, version: 1.5 }).ok, false);
    assert.equal(validatePrd({ ...minimalPrd, version: "1" }).ok, false);
  });

  it("rejects non-string task", () => {
    assert.equal(validatePrd({ ...minimalPrd, task: 42 }).ok, false);
  });

  it("rejects non-array stories", () => {
    assert.equal(validatePrd({ ...minimalPrd, stories: {} }).ok, false);
  });

  it("rejects empty story id", () => {
    const r = validatePrd({
      ...minimalPrd,
      stories: [{ id: "", title: "x", criteria: [], passes: false }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects story with non-string criteria", () => {
    const r = validatePrd({
      ...minimalPrd,
      stories: [{ id: "1", title: "x", criteria: [1, 2], passes: false }],
    });
    assert.equal(r.ok, false);
  });

  it("rejects story with non-boolean passes", () => {
    const r = validatePrd({
      ...minimalPrd,
      stories: [
        { id: "1", title: "x", criteria: [], passes: "false" as never },
      ],
    });
    assert.equal(r.ok, false);
  });

  it("rejects duplicate story ids", () => {
    const r = validatePrd({
      ...minimalPrd,
      stories: [
        { id: "X", title: "a", criteria: [], passes: false },
        { id: "X", title: "b", criteria: [], passes: false },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /duplicate/);
  });

  it("accepts story with optional notes", () => {
    const r = validatePrd({
      ...minimalPrd,
      stories: [
        {
          id: "1",
          title: "x",
          criteria: [],
          passes: false,
          notes: "blocked by upstream",
        },
      ],
    });
    assert.equal(r.ok, true);
  });
});

describe("savePrd / loadPrd", () => {
  it("saves and reads back a PRD round-trip", async () => {
    await withTmpRoot(async (root) => {
      const s = await savePrd(minimalPrd, root);
      assert.equal(s.ok, true);

      const onDisk = JSON.parse(
        await readFile(join(root, "state", PRD_FILENAME), "utf8"),
      );
      assert.equal(onDisk.task, "fix all lint errors");

      const r = await loadPrd(root);
      assert.equal(r.ok, true);
      assert.deepEqual(r.prd, minimalPrd);
    });
  });

  it("loadPrd returns ok=true with no prd when file missing", async () => {
    await withTmpRoot(async (root) => {
      const r = await loadPrd(root);
      assert.equal(r.ok, true);
      assert.equal(r.prd, undefined);
    });
  });

  it("loadPrd reports error on malformed JSON", async () => {
    await withTmpRoot(async (root) => {
      await mkdir(join(root, "state"), { recursive: true });
      await writeFile(
        join(root, "state", PRD_FILENAME),
        "{not valid json",
        "utf8",
      );
      const r = await loadPrd(root);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not valid JSON/);
    });
  });

  it("loadPrd reports error on schema-invalid file", async () => {
    await withTmpRoot(async (root) => {
      await mkdir(join(root, "state"), { recursive: true });
      await writeFile(
        join(root, "state", PRD_FILENAME),
        JSON.stringify({ task: "x", stories: "not an array" }),
        "utf8",
      );
      const r = await loadPrd(root);
      assert.equal(r.ok, false);
    });
  });

  it("savePrd rejects PRD with top-level mode field", async () => {
    await withTmpRoot(async (root) => {
      const r = await savePrd({ ...minimalPrd, mode: "ralph" } as never, root);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /mode/);
    });
  });

  it("savePrd uses atomic tmp+rename (no .tmp left behind)", async () => {
    await withTmpRoot(async (root) => {
      await savePrd(minimalPrd, root);
      const tmpRead = await readFile(
        join(root, "state", `${PRD_FILENAME}.tmp`),
        "utf8",
      ).catch(() => null);
      assert.equal(tmpRead, null, "tmp file should not remain after rename");
    });
  });
});

describe("markStoryPasses", () => {
  it("flips a single story's passes field", async () => {
    await withTmpRoot(async (root) => {
      const prd: RalphPrd = {
        ...minimalPrd,
        stories: [
          { id: "A", title: "a", criteria: [], passes: false },
          { id: "B", title: "b", criteria: [], passes: false },
        ],
      };
      await savePrd(prd, root);
      const r = await markStoryPasses("A", true, root);
      assert.equal(r.ok, true);
      const after = await loadPrd(root);
      assert.equal(after.prd?.stories.find((s) => s.id === "A")?.passes, true);
      assert.equal(after.prd?.stories.find((s) => s.id === "B")?.passes, false);
    });
  });

  it("returns error when PRD missing", async () => {
    await withTmpRoot(async (root) => {
      const r = await markStoryPasses("X", true, root);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /not found/);
    });
  });

  it("returns error when story id unknown", async () => {
    await withTmpRoot(async (root) => {
      await savePrd(minimalPrd, root);
      const r = await markStoryPasses("nonexistent", true, root);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /story id not found/);
    });
  });
});
