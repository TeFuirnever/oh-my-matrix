import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package.json node script entrypoints exist", async () => {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const missing = [];

  for (const [name, command] of Object.entries(scripts)) {
    for (const match of String(command).matchAll(/\bnode\s+([^\s]+\.mjs)/g)) {
      const path = resolve(root, match[1]);
      if (!existsSync(path)) missing.push(`${name}: ${match[1]}`);
    }
  }

  assert.deepEqual(missing, []);
});

test("bundle verifier targets the current package version", async () => {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const script = String(pkg.scripts?.["omm:verify-bundle"] ?? "");

  assert.match(script, new RegExp(`omm-suite-${pkg.version}\\.tgz\\b`));
});

test("suite builder ships every release skill to both bundle roots", async () => {
  const source = await readFile(
    resolve(root, "omm-scripts", "omm-build-suite.mjs"),
    "utf8",
  );
  const coreSkills = ["omm-team"];
  // All non-core skills were removed (see ADR-008); no parked skills remain.
  const parkedSkills = [];

  assert.match(source, /const SHIPPED_SKILLS = \[/);
  assert.match(source, /join\(staging, "omm-skills", skill\)/);
  assert.match(source, /join\(staging, "omm-plugin", "skills", skill\)/);

  // Core skills are in SHIPPED_SKILLS
  for (const skill of coreSkills) {
    assert.match(source, new RegExp(`"${skill}"`), skill);
    assert.equal(
      existsSync(
        resolve(root, "omm-packages", "omm-skills", skill, "SKILL.md"),
      ),
      true,
      skill,
    );
  }

  // Parked skills (none currently) must exist on disk if listed
  for (const skill of parkedSkills) {
    assert.equal(
      existsSync(
        resolve(root, "omm-packages", "omm-skills", skill, "SKILL.md"),
      ),
      true,
      skill,
    );
  }
});

test("bundle verifier reads the expected manifest version dynamically", async () => {
  const source = await readFile(
    resolve(root, "omm-scripts", "omm-verify-bundle.mjs"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /manifest\.version\s*!==\s*["']\d+\.\d+\.\d+["']/,
  );
  assert.match(source, /expectedVersion/);
});

test("MCP TypeScript sources do not contain failed generation sentinels", async () => {
  const sources = [
    "omm-packages/omm-mcp/src/index.ts",
  ];

  for (const source of sources) {
    const text = await readFile(resolve(root, source), "utf8");
    assert.doesNotMatch(text, /^null$/m, source);
  }
});
