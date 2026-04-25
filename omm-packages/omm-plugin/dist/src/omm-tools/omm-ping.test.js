import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOmmPing } from "./omm-ping.js";
test("runOmmPing writes a smoke record under the configured state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "omm-ping-"));
  try {
    const result = await runOmmPing(
      {
        command: "hello",
        commandName: "omm-ping",
        skillName: "omm-ping",
      },
      { stateRoot: root },
    );
    assert.equal(result.content[0]?.text, "omm pong: hello");
    const path = result.details.path;
    assert.equal(path, join(root, "state", "smoke.json"));
    const content = JSON.parse(await readFile(String(path), "utf8"));
    assert.equal(content.message, "hello");
    assert.equal(content.commandName, "omm-ping");
    assert.equal(content.skillName, "omm-ping");
    assert.equal(typeof content.createdAt, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
//# sourceMappingURL=omm-ping.test.js.map
