import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  __resetKeyLocksForTest,
  withCrossProcessLock,
  withKeyLock,
} from "./omm-fs-queue.js";

describe("withKeyLock", () => {
  it("serializes operations on the same key in call order", async () => {
    __resetKeyLocksForTest();
    const order: string[] = [];
    const make = (label: string, ms: number) => async () => {
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${label}:end`);
      return label;
    };
    const p1 = withKeyLock("k", make("a", 30));
    const p2 = withKeyLock("k", make("b", 5));
    const p3 = withKeyLock("k", make("c", 5));
    const results = await Promise.all([p1, p2, p3]);
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.deepEqual(order, [
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("does not serialize across different keys", async () => {
    __resetKeyLocksForTest();
    const order: string[] = [];
    const start = Date.now();
    const p1 = withKeyLock("a", async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a:end");
    });
    const p2 = withKeyLock("b", async () => {
      order.push("b:start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("b:end");
    });
    await Promise.all([p1, p2]);
    const elapsed = Date.now() - start;
    // b finishes before a; if serialized, total would be ≥35ms with b:end last.
    assert.ok(elapsed < 50, `expected parallel run ~30ms, got ${elapsed}ms`);
    assert.equal(order[0], "a:start");
    assert.equal(order[1], "b:start");
  });

  it("continues queue after a rejection without leaking the failure", async () => {
    __resetKeyLocksForTest();
    const failure = withKeyLock("k", async () => {
      throw new Error("boom");
    });
    await assert.rejects(failure, /boom/);
    const ok = await withKeyLock("k", async () => 42);
    assert.equal(ok, 42);
  });

  it("propagates the awaited result and error to its own caller", async () => {
    __resetKeyLocksForTest();
    const value = await withKeyLock("k", async () => "ok");
    assert.equal(value, "ok");
    await assert.rejects(
      withKeyLock("k", async () => {
        throw new Error("nope");
      }),
      /nope/,
    );
  });
});

describe("withCrossProcessLock", () => {
  async function tmpDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "omm-lock-"));
  }

  it("serializes concurrent acquires on the same key (happy path)", async () => {
    __resetKeyLocksForTest();
    const dir = await tmpDir();
    try {
      let inFlight = 0;
      let maxConcurrent = 0;
      const make = (ms: number) => async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, ms));
        inFlight--;
      };
      await Promise.all([
        withCrossProcessLock(dir, "k", make(20)),
        withCrossProcessLock(dir, "k", make(10)),
        withCrossProcessLock(dir, "k", make(10)),
      ]);
      assert.equal(maxConcurrent, 1, "lock must serialize");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries past EEXIST until the prior holder releases", async () => {
    __resetKeyLocksForTest();
    const dir = await tmpDir();
    try {
      const order: string[] = [];
      // Squat the lock file from a separate "process" by writing it directly,
      // then release after a short delay. The lock acquire should retry.
      const lockPath = join(dir, ".locks", "k.lock");
      const { mkdir, writeFile: wf, unlink } = await import("node:fs/promises");
      await mkdir(join(dir, ".locks"), { recursive: true });
      await wf(
        lockPath,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "self" })}\n`,
        { flag: "wx" },
      );
      const released = (async () => {
        await new Promise((r) => setTimeout(r, 120));
        order.push("released");
        await unlink(lockPath);
      })();
      const acquired = withCrossProcessLock(
        dir,
        "k",
        async () => {
          order.push("ran");
          return "ok";
        },
        { timeoutMs: 2000 },
      );
      const [, val] = await Promise.all([released, acquired]);
      assert.equal(val, "ok");
      assert.deepEqual(order, ["released", "ran"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock whose recorded PID is dead", async () => {
    __resetKeyLocksForTest();
    const dir = await tmpDir();
    try {
      // Synthesize a stale lockfile: very old mtime + a PID that is
      // guaranteed unused (negative PID is rejected by the alive check).
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, ".locks"), { recursive: true });
      const lockPath = join(dir, ".locks", "k.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: -1, startedAt: new Date(0).toISOString(), hostname: "ghost-host-not-this-machine" })}\n`,
      );
      const oldTime = new Date(Date.now() - 60_000);
      await utimes(lockPath, oldTime, oldTime);

      const value = await withCrossProcessLock(
        dir,
        "k",
        async () => "reclaimed",
        { staleMs: 5_000, timeoutMs: 2_000 },
      );
      assert.equal(value, "reclaimed");
      // Lock file should be cleaned up after fn returns.
      await assert.rejects(stat(lockPath), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws OMM_E_LOCK_TIMEOUT when the lock cannot be acquired in time", async () => {
    __resetKeyLocksForTest();
    const dir = await tmpDir();
    try {
      // A live PID (this process) at a fresh mtime → never considered stale.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, ".locks"), { recursive: true });
      const lockPath = join(dir, ".locks", "k.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: "self" })}\n`,
      );
      await assert.rejects(
        withCrossProcessLock(dir, "k", async () => "should-not-run", {
          timeoutMs: 200,
          staleMs: 60_000,
        }),
        /OMM_E_LOCK_TIMEOUT: k/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("releases the lock even when fn throws (try/finally cleanup)", async () => {
    __resetKeyLocksForTest();
    const dir = await tmpDir();
    try {
      const lockPath = join(dir, ".locks", "k.lock");
      await assert.rejects(
        withCrossProcessLock(dir, "k", async () => {
          throw new Error("explode");
        }),
        /explode/,
      );
      await assert.rejects(stat(lockPath), /ENOENT/);
      // Subsequent acquire should still succeed.
      const v = await withCrossProcessLock(dir, "k", async () => 7);
      assert.equal(v, 7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
