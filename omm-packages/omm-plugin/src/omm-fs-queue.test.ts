import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __resetKeyLocksForTest, withKeyLock } from "./omm-fs-queue.js";

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
