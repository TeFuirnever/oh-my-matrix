import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOmmCancel } from "./omm-cancel.js";
test("runOmmCancel writes a cancel record under the configured state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "omm-cancel-"));
  try {
    const result = await runOmmCancel(
      { sessionId: "test-session-123" },
      { stateRoot: root },
    );
    assert.equal(result.content[0]?.text, "omm cancel: session cancelled");
    const path = result.details.path;
    assert.equal(path, join(root, "state", "cancel.json"));
    const content = JSON.parse(await readFile(String(path), "utf8"));
    assert.equal(content.sessionId, "test-session-123");
    assert.equal(content.message, "session cancelled");
    assert.equal(typeof content.cancelledAt, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
//# sourceMappingURL=omm-cancel.test.js.map
