/**
 * omm-register integration tests — exercise the OpenClaw runtime call shape.
 *
 * These tests catch a class of bug where `execute: (params) => ...` looks
 * right but actually receives the toolCallId string in `params`, because
 * OpenClaw calls `execute(toolCallId, params, signal, onUpdate)`. A 1-arg
 * declaration silently captures the id and ignores everything else.
 *
 * The bug shipped in 0.2.1 — every `params.field` access returned undefined,
 * and `omm_state_read({key:"x"})` failed with `"key is required"` because
 * the sanitizer saw a string toolCallId instead of an args object.
 *
 * These tests invoke each registered tool's `execute` with the real 4-arg
 * runtime shape and assert that the params reach the underlying handler.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { register } from "./omm-register.js";

interface RegisteredTool {
  name: string;
  parameters?: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (delta: string) => void,
  ) => Promise<unknown>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
}

async function registerWithTempRoot(): Promise<{
  tools: Record<string, RegisteredTool>;
  stateRoot: string;
  cleanup: () => Promise<void>;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), "omm-register-test-"));
  const tools: Record<string, RegisteredTool> = {};
  register({
    registerTool: (tool) => {
      tools[tool.name] = tool as RegisteredTool;
    },
    config: { stateRoot },
  });
  return {
    tools,
    stateRoot,
    cleanup: () => rm(stateRoot, { recursive: true, force: true }),
  };
}

describe("omm-register: 4-arg execute(toolCallId, params, signal, onUpdate)", () => {
  it("registers all five tools", async () => {
    const { tools, cleanup } = await registerWithTempRoot();
    try {
      assert.ok(tools.omm_ping);
      assert.ok(tools.omm_cancel);
      assert.ok(tools.omm_state_write);
      assert.ok(tools.omm_state_read);
      assert.ok(tools.omm_state_list);
    } finally {
      await cleanup();
    }
  });

  it("omm_state_read receives params at arg2, returns 'null' for missing key", async () => {
    const { tools, cleanup } = await registerWithTempRoot();
    try {
      // Real OpenClaw call shape — toolCallId first, params second.
      const result = (await tools.omm_state_read.execute(
        "call-id-abc123",
        { key: "doesnotexist" },
        undefined,
        () => undefined,
      )) as ToolResult;
      // Bug regression guard: would return "key is required" if the
      // signature regressed to (params) and captured the toolCallId.
      assert.equal(
        result.content[0].text,
        "null",
        `expected "null" for missing key, got: ${result.content[0].text}`,
      );
    } finally {
      await cleanup();
    }
  });

  it("omm_state_write writes params and is round-trip readable", async () => {
    const { tools, stateRoot, cleanup } = await registerWithTempRoot();
    try {
      const writeResult = (await tools.omm_state_write.execute(
        "call-id-write",
        {
          key: "ralph",
          value: { mode: "ralph", active: false, status: "complete" },
        },
        undefined,
        () => undefined,
      )) as ToolResult;
      assert.match(writeResult.content[0].text, /omm_state_write: ralph/);

      // Verify the file actually exists at the expected path.
      const onDisk = await readFile(
        join(stateRoot, "state", "ralph.json"),
        "utf8",
      );
      assert.match(onDisk, /"mode": "ralph"/);

      // Round-trip via omm_state_read.
      const readResult = (await tools.omm_state_read.execute(
        "call-id-read",
        { key: "ralph" },
        undefined,
        () => undefined,
      )) as ToolResult;
      assert.match(readResult.content[0].text, /"mode": "ralph"/);
    } finally {
      await cleanup();
    }
  });

  it("omm_state_list returns the keys present", async () => {
    const { tools, cleanup } = await registerWithTempRoot();
    try {
      // Seed a key.
      await tools.omm_state_write.execute(
        "id1",
        {
          key: "team",
          value: { mode: "team", active: false, current_phase: "complete" },
        },
        undefined,
        () => undefined,
      );
      const listResult = (await tools.omm_state_list.execute(
        "id2",
        {},
        undefined,
        () => undefined,
      )) as ToolResult;
      const keys = JSON.parse(listResult.content[0].text);
      assert.ok(Array.isArray(keys));
      assert.ok(keys.includes("team"));
    } finally {
      await cleanup();
    }
  });

  it("omm_ping receives params at arg2, not toolCallId", async () => {
    const { tools, cleanup } = await registerWithTempRoot();
    try {
      const result = (await tools.omm_ping.execute(
        "call-id-ping",
        { command: "explicit-command", commandName: "test", skillName: "x" },
        undefined,
        () => undefined,
      )) as ToolResult;
      // If the signature regresses, command falls through to default "ping".
      assert.match(result.content[0].text, /^omm pong: explicit-command$/);
      const record = result.details?.record as Record<string, unknown>;
      assert.equal(record.commandName, "test");
      assert.equal(record.skillName, "x");
    } finally {
      await cleanup();
    }
  });

  it("omm_cancel receives params at arg2", async () => {
    const { tools, cleanup } = await registerWithTempRoot();
    try {
      const result = (await tools.omm_cancel.execute(
        "call-id-cancel",
        { sessionId: "session-xyz" },
        undefined,
        () => undefined,
      )) as ToolResult;
      // If sessionId is undefined (signature regression), the cancel record
      // would still write but with sessionId=null. Verify it round-trips.
      const record = result.details?.record as Record<string, unknown>;
      assert.equal(record.sessionId, "session-xyz");
    } finally {
      await cleanup();
    }
  });

  it("execute remains tolerant when signal/onUpdate are omitted", async () => {
    const { tools, cleanup } = await registerWithTempRoot();
    try {
      // Some runtime call sites (the HTTP gateway) pass only (id, params).
      const result = (await tools.omm_state_read.execute("id3", {
        key: "absent",
      })) as ToolResult;
      assert.equal(result.content[0].text, "null");
    } finally {
      await cleanup();
    }
  });
});
