import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendProgressEntry,
  loadProgress,
  PROGRESS_FILENAME,
  validateProgressEntry,
} from "./omm-ralph-progress.js";

async function withTmpRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omm-ralph-progress-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("validateProgressEntry", () => {
  it("accepts a minimal valid entry", () => {
    assert.equal(
      validateProgressEntry({
        iteration: 0,
        timestamp: "2026-04-26T10:00:00Z",
        summary: "kicked off",
      }),
      null,
    );
  });

  it("rejects negative iteration", () => {
    assert.match(
      validateProgressEntry({
        iteration: -1,
        timestamp: "2026-04-26T10:00:00Z",
        summary: "x",
      }) ?? "",
      /non-negative/,
    );
  });

  it("rejects non-integer iteration", () => {
    assert.match(
      validateProgressEntry({
        iteration: 1.5,
        timestamp: "2026-04-26T10:00:00Z",
        summary: "x",
      }) ?? "",
      /non-negative/,
    );
  });

  it("rejects bad timestamp", () => {
    assert.match(
      validateProgressEntry({
        iteration: 0,
        timestamp: "not a date",
        summary: "x",
      }) ?? "",
      /timestamp/,
    );
  });

  it("rejects non-string summary", () => {
    assert.match(
      validateProgressEntry({
        iteration: 0,
        timestamp: "2026-04-26T10:00:00Z",
        summary: 42,
      }) ?? "",
      /summary/,
    );
  });

  it("rejects non-string-array lessons", () => {
    assert.match(
      validateProgressEntry({
        iteration: 0,
        timestamp: "2026-04-26T10:00:00Z",
        summary: "x",
        lessons: [1, 2],
      }) ?? "",
      /lessons/,
    );
  });

  it("accepts entry with optional lessons", () => {
    assert.equal(
      validateProgressEntry({
        iteration: 1,
        timestamp: "2026-04-26T10:00:00Z",
        summary: "fixed bug",
        lessons: ["validate input early"],
      }),
      null,
    );
  });
});

describe("appendProgressEntry / loadProgress", () => {
  it("appends and reads back one entry", async () => {
    await withTmpRoot(async (root) => {
      const r = await appendProgressEntry(
        { iteration: 0, summary: "started" },
        root,
      );
      assert.equal(r.ok, true);
      const entries = await loadProgress(root);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].iteration, 0);
      assert.equal(entries[0].summary, "started");
      assert.ok(Number.isFinite(Date.parse(entries[0].timestamp)));
    });
  });

  it("appends multiple entries in order", async () => {
    await withTmpRoot(async (root) => {
      await appendProgressEntry({ iteration: 0, summary: "a" }, root);
      await appendProgressEntry({ iteration: 1, summary: "b" }, root);
      await appendProgressEntry({ iteration: 2, summary: "c" }, root);
      const entries = await loadProgress(root);
      assert.equal(entries.length, 3);
      assert.equal(entries[0].summary, "a");
      assert.equal(entries[1].summary, "b");
      assert.equal(entries[2].summary, "c");
    });
  });

  it("preserves explicit timestamp when provided", async () => {
    await withTmpRoot(async (root) => {
      await appendProgressEntry(
        {
          iteration: 0,
          timestamp: "2026-04-26T12:00:00.000Z",
          summary: "x",
        },
        root,
      );
      const entries = await loadProgress(root);
      assert.equal(entries[0].timestamp, "2026-04-26T12:00:00.000Z");
    });
  });

  it("preserves lessons when provided", async () => {
    await withTmpRoot(async (root) => {
      await appendProgressEntry(
        {
          iteration: 1,
          summary: "x",
          lessons: ["learn one", "learn two"],
        },
        root,
      );
      const entries = await loadProgress(root);
      assert.deepEqual(entries[0].lessons, ["learn one", "learn two"]);
    });
  });

  it("rejects invalid entry on append (validates before writing)", async () => {
    await withTmpRoot(async (root) => {
      const r = await appendProgressEntry(
        { iteration: -1, summary: "bad" },
        root,
      );
      assert.equal(r.ok, false);
      const entries = await loadProgress(root);
      assert.equal(entries.length, 0);
    });
  });

  it("loadProgress returns empty array when file missing", async () => {
    await withTmpRoot(async (root) => {
      const entries = await loadProgress(root);
      assert.deepEqual(entries, []);
    });
  });

  it("loadProgress skips malformed lines (failsafe)", async () => {
    await withTmpRoot(async (root) => {
      await mkdir(join(root, "state"), { recursive: true });
      const path = join(root, "state", PROGRESS_FILENAME);
      const lines = [
        JSON.stringify({
          iteration: 0,
          timestamp: "2026-04-26T10:00:00Z",
          summary: "ok",
        }),
        "{not valid json",
        JSON.stringify({
          iteration: 1,
          timestamp: "2026-04-26T10:01:00Z",
          summary: "also ok",
        }),
        "", // blank line
      ];
      await writeFile(path, `${lines.join("\n")}\n`, "utf8");
      const entries = await loadProgress(root);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].summary, "ok");
      assert.equal(entries[1].summary, "also ok");
    });
  });

  it("loadProgress skips schema-invalid lines", async () => {
    await withTmpRoot(async (root) => {
      await mkdir(join(root, "state"), { recursive: true });
      const path = join(root, "state", PROGRESS_FILENAME);
      const lines = [
        JSON.stringify({ summary: "missing iteration" }),
        JSON.stringify({
          iteration: 0,
          timestamp: "2026-04-26T10:00:00Z",
          summary: "valid",
        }),
      ];
      await writeFile(path, `${lines.join("\n")}\n`, "utf8");
      const entries = await loadProgress(root);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].summary, "valid");
    });
  });

  it("tolerates partial trailing line (simulates crash mid-append)", async () => {
    await withTmpRoot(async (root) => {
      await mkdir(join(root, "state"), { recursive: true });
      const path = join(root, "state", PROGRESS_FILENAME);
      const goodLine = JSON.stringify({
        iteration: 0,
        timestamp: "2026-04-26T10:00:00Z",
        summary: "ok",
      });
      // Partial trailing line (no newline, truncated JSON)
      await writeFile(path, `${goodLine}\n{"iteration":1,"timest`, "utf8");
      const entries = await loadProgress(root);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].summary, "ok");
    });
  });

  it("file persists across multiple append calls", async () => {
    await withTmpRoot(async (root) => {
      await appendProgressEntry({ iteration: 0, summary: "first" }, root);
      const path = join(root, "state", PROGRESS_FILENAME);
      const raw1 = await readFile(path, "utf8");
      assert.equal(raw1.split("\n").filter(Boolean).length, 1);

      await appendProgressEntry({ iteration: 1, summary: "second" }, root);
      const raw2 = await readFile(path, "utf8");
      assert.equal(raw2.split("\n").filter(Boolean).length, 2);
    });
  });
});
