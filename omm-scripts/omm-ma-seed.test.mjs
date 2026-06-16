import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import {
  buildMcpServers,
  mergeMcpConfig,
  parseArgs,
  resolveSeedTargetPath,
  seedMatrixAssistantConfig,
} from "./omm-ma-seed.mjs";

function slash(path) {
  return path.replaceAll("\\", "/");
}

test("buildMcpServers emits OpenClaw-native server entries (no type/enabled/tags)", async () => {
  const servers = await buildMcpServers({
    ommRoot: "D:\\Matrix\\oh-my-matrix",
    layout: "source",
    stateRoot: "D:\\Matrix\\oh-my-matrix\\.omm-dev-state",
  });

  assert.deepEqual(Object.keys(servers), ["omm-state"]);
  const entry = servers["omm-state"];
  assert.equal(entry.command, "node");
  assert.equal(entry.type, undefined);
  assert.equal(entry.enabled, undefined);
  assert.equal(entry.tags, undefined);
  assert.deepEqual(entry.args, [
    resolve(
      "D:\\Matrix\\oh-my-matrix",
      "omm-packages",
      "omm-mcp",
      "dist",
      "src",
      "index.js",
    ),
  ]);
  assert.deepEqual(entry.env, {
    OMM_STATE_ROOT: resolve("D:\\Matrix\\oh-my-matrix\\.omm-dev-state"),
  });
});

test("buildMcpServers supports unpacked suite layout without env", async () => {
  const servers = await buildMcpServers({
    ommRoot: "/opt/omm-suite",
    layout: "suite",
  });

  assert.match(
    slash(servers["omm-state"].args[0]),
    /\/opt\/omm-suite\/omm-mcp\/dist\/src\/index\.js$/,
  );
  assert.equal(servers["omm-state"].env, undefined);
});

test("mergeMcpConfig inserts into mcp.servers (OpenClaw native format)", async () => {
  const servers = await buildMcpServers({ layout: "source" });
  const existing = {
    plugins: { allow: ["kept"] },
    mcp: {
      servers: {
        "matrix-mcp-playwright": { command: "node", args: ["playwright.js"] },
        context7: { command: "npx", args: ["context7"] },
      },
    },
  };

  const first = mergeMcpConfig(existing, servers);
  assert.equal(first.key, "mcp");
  assert.equal(first.changed, true);
  assert.equal(first.config.plugins, existing.plugins);
  assert.ok(first.config.mcp.servers["matrix-mcp-playwright"]);
  assert.ok(first.config.mcp.servers.context7);
  assert.ok(first.config.mcp.servers["omm-state"]);
  assert.deepEqual(
    first.actions.map((item) => item.action),
    ["inserted"],
  );

  const second = mergeMcpConfig(first.config, servers);
  assert.equal(second.changed, false);
  assert.deepEqual(
    second.actions.map((item) => item.action),
    ["unchanged"],
  );
});

test("mergeMcpConfig preserves custom omm entries unless forced", async () => {
  const servers = await buildMcpServers({ layout: "source" });
  const existing = {
    mcp: {
      servers: {
        "omm-state": {
          command: "node",
          args: ["custom.js"],
        },
      },
    },
  };

  const skipped = mergeMcpConfig(existing, servers);
  assert.equal(skipped.config.mcp.servers["omm-state"].args[0], "custom.js");
  assert.equal(skipped.actions[0].action, "skipped-conflict");
  assert.equal(skipped.warnings.length, 1);

  const forced = mergeMcpConfig(existing, servers, { force: true });
  assert.equal(forced.actions[0].action, "overwritten");
  assert.equal(
    forced.config.mcp.servers["omm-state"].args[0],
    servers["omm-state"].args[0],
  );
});

test("mergeMcpConfig falls back to servers key when mcp.servers absent", async () => {
  const servers = await buildMcpServers({ layout: "suite" });
  const result = mergeMcpConfig(
    {
      servers: { existing: { command: "node" } },
    },
    servers,
  );

  assert.equal(result.key, "servers");
  assert.ok(result.config.servers["omm-state"]);
  assert.ok(result.config.servers.existing);
});

test("mergeMcpConfig falls back to mcpServers key when others absent", async () => {
  const servers = await buildMcpServers({ layout: "suite" });
  const result = mergeMcpConfig(
    { mcpServers: { existing: { command: "node" } } },
    servers,
  );

  assert.equal(result.key, "mcpServers");
  assert.ok(result.config.mcpServers["omm-state"]);
  assert.ok(result.config.mcpServers.existing);
});

test("seedMatrixAssistantConfig writes atomically and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omm-ma-seed-"));
  const target = join(dir, "openclaw.json");

  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `${JSON.stringify(
        {
          plugins: { keep: true },
          mcp: { servers: {} },
        },
        null,
        2,
      )}\n`,
    );

    const first = await seedMatrixAssistantConfig({
      scope: "user",
      target,
      ommRoot: "D:\\Matrix\\oh-my-matrix",
      layout: "source",
      verifyFiles: false,
      write: true,
    });
    assert.equal(first.changed, true);
    assert.equal(first.key, "mcp");

    const parsed = JSON.parse(await readFile(target, "utf8"));
    assert.deepEqual(parsed.plugins, { keep: true });
    assert.ok(parsed.mcp.servers["omm-state"]);

    const second = await seedMatrixAssistantConfig({
      scope: "user",
      target,
      ommRoot: "D:\\Matrix\\oh-my-matrix",
      layout: "source",
      verifyFiles: false,
      write: true,
    });
    assert.equal(second.changed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveSeedTargetPath returns ~/.openclaw/openclaw.json for user scope", () => {
  const path = slash(resolveSeedTargetPath({ scope: "user" }));
  assert.match(path, /\.openclaw\/openclaw\.json$/);
});

test("resolveSeedTargetPath requires workspace for project and local scopes", () => {
  assert.throws(
    () => resolveSeedTargetPath({ scope: "project" }),
    /--workspace is required/,
  );
  assert.match(
    slash(resolveSeedTargetPath({ scope: "local", workspace: "/repo" })),
    /\/repo\/\.mcp\.local\.json$/,
  );
});

test("parseArgs keeps writes explicit", () => {
  assert.equal(parseArgs([]).write, false);
  assert.equal(parseArgs(["--write"]).write, true);
  assert.equal(parseArgs(["--write", "--dry-run"]).write, false);
});
