import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import {
  buildOpenClawPluginInstall,
  mergeOpenClawConfig,
  parseArgs,
  resolveOpenClawSeedTargetPath,
  seedOpenClawConfig,
} from "./omm-openclaw-seed.mjs";

function slash(path) {
  return path.replaceAll("\\", "/");
}

test("buildOpenClawPluginInstall resolves source checkout through built suite staging", async () => {
  const install = await buildOpenClawPluginInstall({
    ommRoot: "D:\\Matrix\\oh-my-matrix",
    layout: "source",
    stateRoot: "D:\\Matrix\\oh-my-matrix\\.omm-dev-state",
  });

  assert.equal(install.pluginId, "omm");
  assert.match(
    slash(install.pluginPath),
    /\/Matrix\/oh-my-matrix\/omm-dist\/omm-suite\/omm-plugin$/,
  );
  assert.deepEqual(install.entry, {
    enabled: true,
    config: {
      enabled: true,
      stateRoot: resolve("D:\\Matrix\\oh-my-matrix\\.omm-dev-state"),
    },
  });
});

test("buildOpenClawPluginInstall supports unpacked suite layout", async () => {
  const install = await buildOpenClawPluginInstall({
    ommRoot: "D:\\Opt\\omm-suite",
    layout: "suite",
    promptsDir: "D:\\Opt\\custom-prompts",
  });

  assert.match(slash(install.pluginPath), /\/Opt\/omm-suite\/omm-plugin$/);
  assert.match(
    slash(install.entry.config.promptsDir),
    /\/Opt\/custom-prompts$/,
  );
});

test("mergeOpenClawConfig inserts omm plugin registration without touching existing config", async () => {
  const install = await buildOpenClawPluginInstall({ layout: "source" });
  const existing = {
    gateway: { mode: "local" },
    plugins: {
      allow: ["memory-core"],
      load: { paths: ["D:\\Matrix\\MatrixAssistant\\resources\\plugins"] },
      entries: {
        "memory-core": { config: { dreaming: { enabled: true } } },
      },
    },
  };

  const first = mergeOpenClawConfig(existing, install);
  assert.equal(first.changed, true);
  assert.deepEqual(
    first.actions.map((item) => item.action),
    ["inserted", "inserted", "inserted"],
  );
  assert.deepEqual(first.config.gateway, existing.gateway);
  assert.ok(first.config.plugins.allow.includes("omm"));
  assert.ok(first.config.plugins.load.paths.includes(install.pluginPath));
  assert.deepEqual(first.config.plugins.entries.omm, install.entry);
  assert.ok(first.config.plugins.entries["memory-core"]);

  const second = mergeOpenClawConfig(first.config, install);
  assert.equal(second.changed, false);
  assert.deepEqual(
    second.actions.map((item) => item.action),
    ["unchanged", "unchanged", "unchanged"],
  );
});

test("mergeOpenClawConfig preserves custom omm entries unless forced", async () => {
  const install = await buildOpenClawPluginInstall({ layout: "suite" });
  const existing = {
    plugins: {
      allow: ["omm"],
      load: { paths: [install.pluginPath] },
      entries: {
        omm: {
          enabled: false,
          config: { enabled: false, stateRoot: "custom" },
        },
      },
    },
  };

  const skipped = mergeOpenClawConfig(existing, install);
  assert.equal(skipped.config.plugins.entries.omm.enabled, false);
  assert.equal(skipped.actions[2].action, "skipped-conflict");
  assert.equal(skipped.warnings.length, 1);

  const forced = mergeOpenClawConfig(existing, install, { force: true });
  assert.equal(forced.actions[2].action, "overwritten");
  assert.deepEqual(forced.config.plugins.entries.omm, install.entry);
});

test("mergeOpenClawConfig treats slash-equivalent plugin paths as unchanged", async () => {
  const install = await buildOpenClawPluginInstall({ layout: "source" });
  const existing = {
    plugins: {
      load: { paths: [slash(install.pluginPath)] },
    },
  };

  const merged = mergeOpenClawConfig(existing, install);
  assert.equal(merged.actions[1].action, "unchanged");
  assert.equal(merged.config.plugins.load.paths.length, 1);
  assert.equal(merged.config.plugins.load.paths[0], slash(install.pluginPath));
});

test("mergeOpenClawConfig rejects malformed plugin sections instead of overwriting them", async () => {
  const install = await buildOpenClawPluginInstall({ layout: "source" });

  assert.throws(
    () => mergeOpenClawConfig({ plugins: { allow: "omm" } }, install),
    /plugins\.allow must be a JSON array/,
  );
  assert.throws(
    () =>
      mergeOpenClawConfig({ plugins: { load: { paths: "D:\\bad" } } }, install),
    /plugins\.load\.paths must be a JSON array/,
  );
});

test("seedOpenClawConfig writes atomically and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omm-openclaw-seed-"));
  const target = join(dir, ".openclaw", "openclaw.json");

  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `${JSON.stringify({ plugins: { allow: [], entries: {} } }, null, 2)}\n`,
    );

    const first = await seedOpenClawConfig({
      target,
      ommRoot: "D:\\Matrix\\oh-my-matrix",
      layout: "source",
      verifyFiles: false,
      write: true,
    });
    assert.equal(first.changed, true);

    const parsed = JSON.parse(await readFile(target, "utf8"));
    assert.ok(parsed.plugins.allow.includes("omm"));
    assert.ok(parsed.plugins.load.paths.includes(first.pluginPath));
    assert.deepEqual(parsed.plugins.entries.omm, {
      enabled: true,
      config: { enabled: true },
    });

    const second = await seedOpenClawConfig({
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

test("resolveOpenClawSeedTargetPath defaults to OpenClaw home config", () => {
  assert.match(
    slash(resolveOpenClawSeedTargetPath()),
    /\/\.openclaw\/openclaw\.json$/,
  );
});

test("parseArgs keeps writes explicit", () => {
  assert.equal(parseArgs([]).write, false);
  assert.equal(parseArgs(["--write"]).write, true);
  assert.equal(parseArgs(["--write", "--dry-run"]).write, false);
});
