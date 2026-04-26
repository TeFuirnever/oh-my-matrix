import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  runOmmStateList,
  runOmmStateRead,
  runOmmStateWrite,
  sanitizeStateKey,
} from "./omm-state.js";
async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "omm-state-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
describe("omm_state_write", () => {
  it("writes validated ralph state", async () => {
    await withTmpDir(async (dir) => {
      const r = await runOmmStateWrite(
        { key: "ralph", value: { mode: "ralph", active: true, task: "test" } },
        { stateRoot: dir },
      );
      assert.ok(r.content[0].text.includes("omm_state_write: ralph"));
      const raw = await readFile(join(dir, "state", "ralph.json"), "utf8");
      const data = JSON.parse(raw);
      assert.equal(data.status, "init");
      assert.equal(data.iteration, 0);
    });
  });
  it("rejects invalid state", async () => {
    await withTmpDir(async (dir) => {
      const r = await runOmmStateWrite(
        { key: "ralph", value: { mode: "ralph", status: "bogus" } },
        { stateRoot: dir },
      );
      assert.ok(r.content[0].text.includes("error"));
    });
  });
  it("rejects missing key", async () => {
    await withTmpDir(async (dir) => {
      const r = await runOmmStateWrite(
        { value: { foo: 1 } },
        { stateRoot: dir },
      );
      assert.ok(r.content[0].text.includes("key is required"));
    });
  });
});
describe("omm_state_read", () => {
  it("reads written state", async () => {
    await withTmpDir(async (dir) => {
      await runOmmStateWrite(
        {
          key: "ralph",
          value: { mode: "ralph", active: false, status: "complete" },
        },
        { stateRoot: dir },
      );
      const r = await runOmmStateRead({ key: "ralph" }, { stateRoot: dir });
      const data = JSON.parse(r.content[0].text);
      assert.equal(data.status, "complete");
    });
  });
  it("returns null for missing key", async () => {
    await withTmpDir(async (dir) => {
      const r = await runOmmStateRead(
        { key: "nonexistent" },
        { stateRoot: dir },
      );
      assert.equal(r.content[0].text, "null");
    });
  });
});
describe("omm_state_list", () => {
  it("lists keys after writes", async () => {
    await withTmpDir(async (dir) => {
      await runOmmStateWrite(
        { key: "ralph", value: { mode: "ralph", active: true } },
        { stateRoot: dir },
      );
      await runOmmStateWrite(
        { key: "custom", value: { foo: 1 } },
        { stateRoot: dir },
      );
      const r = await runOmmStateList({}, { stateRoot: dir });
      const keys = JSON.parse(r.content[0].text);
      assert.ok(keys.includes("ralph"));
      assert.ok(keys.includes("custom"));
    });
  });
  it("returns empty for fresh dir", async () => {
    await withTmpDir(async (dir) => {
      const r = await runOmmStateList({}, { stateRoot: dir });
      assert.equal(r.content[0].text, "[]");
    });
  });
});
describe("sanitizeStateKey", () => {
  it("accepts safe keys", () => {
    for (const k of ["ralph", "autopilot", "team", "custom_key", "k-1", "a"]) {
      assert.equal(sanitizeStateKey(k).ok, true, k);
    }
  });
  it("rejects path traversal attempts", () => {
    for (const k of [
      "../etc/passwd",
      "..\\windows\\system32",
      "foo/bar",
      "foo\\bar",
      "./foo",
      ".hidden",
      "-leading-dash",
    ]) {
      assert.equal(sanitizeStateKey(k).ok, false, k);
    }
  });
  it("rejects null bytes and special characters", () => {
    for (const k of [
      "foo\0bar",
      "foo bar",
      "foo;bar",
      "foo:bar",
      "foo.json",
      "foo*",
      "foo?",
    ]) {
      assert.equal(sanitizeStateKey(k).ok, false, k);
    }
  });
  it("rejects empty and non-string input", () => {
    assert.equal(sanitizeStateKey("").ok, false);
    assert.equal(sanitizeStateKey("   ").ok, false);
    assert.equal(sanitizeStateKey(undefined).ok, false);
    assert.equal(sanitizeStateKey(null).ok, false);
    assert.equal(sanitizeStateKey(123).ok, false);
  });
  it("rejects keys exceeding 64 chars", () => {
    assert.equal(sanitizeStateKey("a".repeat(65)).ok, false);
    assert.equal(sanitizeStateKey("a".repeat(64)).ok, true);
  });
});
describe("path traversal defense (integration)", () => {
  it("write rejects ../ keys without touching filesystem", async () => {
    await withTmpDir(async (dir) => {
      const r = await runOmmStateWrite(
        { key: "../escape", value: { foo: 1 } },
        { stateRoot: dir },
      );
      assert.ok(r.content[0].text.includes("error"));
      assert.ok(r.content[0].text.includes("key must match"));
    });
  });
  it("read rejects path separator keys", async () => {
    await withTmpDir(async (dir) => {
      const r = await runOmmStateRead({ key: "foo/bar" }, { stateRoot: dir });
      assert.ok(r.content[0].text.includes("error"));
    });
  });
});
describe("workflow exclusivity (integration via runOmmStateWrite)", () => {
  it("rejects autopilot active=true while ralph is active", async () => {
    await withTmpDir(async (dir) => {
      const a = await runOmmStateWrite(
        { key: "ralph", value: { mode: "ralph", active: true } },
        { stateRoot: dir },
      );
      assert.ok(a.content[0].text.startsWith("omm_state_write: ralph"));
      const b = await runOmmStateWrite(
        { key: "autopilot", value: { mode: "autopilot", active: true } },
        { stateRoot: dir },
      );
      assert.ok(b.content[0].text.includes("error"));
      assert.match(b.content[0].text, /ralph is already active/);
    });
  });
  it("allows autopilot active=true after ralph terminates", async () => {
    await withTmpDir(async (dir) => {
      await runOmmStateWrite(
        { key: "ralph", value: { mode: "ralph", active: true } },
        { stateRoot: dir },
      );
      await runOmmStateWrite(
        {
          key: "ralph",
          value: { mode: "ralph", active: false, status: "complete" },
        },
        { stateRoot: dir },
      );
      const r = await runOmmStateWrite(
        { key: "autopilot", value: { mode: "autopilot", active: true } },
        { stateRoot: dir },
      );
      assert.ok(r.content[0].text.startsWith("omm_state_write: autopilot"));
    });
  });
});
//# sourceMappingURL=omm-state.test.js.map
