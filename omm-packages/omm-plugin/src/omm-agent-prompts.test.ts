import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AgentPrompt,
  listAgentPrompts,
  loadAgentPrompt,
  parseAgentPrompt,
} from "./omm-agent-prompts.js";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PROMPTS_DIR = join(
  here,
  "..",
  "..",
  "..",
  "omm-skills",
  "agent-prompts",
);

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "omm-prompts-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const validPrompt = `---
name: tester
model_tier: sonnet
purpose: A purpose statement
---

The body of the prompt goes here.
Multiple lines are fine.
`;

describe("parseAgentPrompt", () => {
  it("parses a valid prompt", () => {
    const p = parseAgentPrompt(validPrompt);
    assert.equal(p.name, "tester");
    assert.equal(p.modelTier, "sonnet");
    assert.equal(p.purpose, "A purpose statement");
    assert.match(p.body, /The body/);
  });

  it("trims trailing whitespace from body", () => {
    const p = parseAgentPrompt(`${validPrompt}\n\n   \n`);
    assert.ok(!p.body.endsWith("\n"));
  });

  it("rejects missing frontmatter fence", () => {
    assert.throws(
      () => parseAgentPrompt("no frontmatter here"),
      /frontmatter fence/,
    );
  });

  it("rejects invalid name", () => {
    assert.throws(
      () =>
        parseAgentPrompt(
          "---\nname: 1bad\nmodel_tier: sonnet\npurpose: x\n---\n\nbody",
        ),
      /name must match/,
    );
  });

  it("rejects unknown model tier", () => {
    assert.throws(
      () =>
        parseAgentPrompt(
          "---\nname: ok\nmodel_tier: gpt\npurpose: x\n---\n\nbody",
        ),
      /model_tier must be one of/,
    );
  });

  it("rejects missing purpose", () => {
    assert.throws(
      () => parseAgentPrompt("---\nname: ok\nmodel_tier: sonnet\n---\n\nbody"),
      /purpose is required/,
    );
  });

  it("rejects empty body", () => {
    assert.throws(
      () =>
        parseAgentPrompt(
          "---\nname: ok\nmodel_tier: sonnet\npurpose: x\n---\n\n   \n",
        ),
      /body is empty/,
    );
  });

  it("rejects malformed frontmatter line", () => {
    assert.throws(
      () =>
        parseAgentPrompt(
          "---\nname: ok\nmodel_tier sonnet\npurpose: x\n---\n\nbody",
        ),
      /invalid frontmatter line/,
    );
  });

  it("ignores unknown frontmatter keys (forward-compat)", () => {
    const p = parseAgentPrompt(
      "---\nname: ok\nmodel_tier: sonnet\npurpose: x\nfuture: yes\n---\n\nbody",
    );
    assert.equal(p.name, "ok");
  });
});

describe("loadAgentPrompt + listAgentPrompts (file system)", () => {
  it("loads a prompt from disk", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "tester.md"), validPrompt, "utf8");
      const p = await loadAgentPrompt("tester", dir);
      assert.equal(p.name, "tester");
      assert.equal(p.modelTier, "sonnet");
    });
  });

  it("rejects when filename does not match frontmatter name", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "wrongname.md"), validPrompt, "utf8");
      await assert.rejects(
        () => loadAgentPrompt("wrongname", dir),
        /does not match filename/,
      );
    });
  });

  it("throws on invalid name passed to loadAgentPrompt", async () => {
    await assert.rejects(
      () => loadAgentPrompt("../escape"),
      /invalid agent prompt name/,
    );
  });

  it("listAgentPrompts returns sorted names from .md files", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, "alpha.md"), validPrompt, "utf8");
      await writeFile(join(dir, "beta.md"), validPrompt, "utf8");
      await writeFile(join(dir, "README.txt"), "ignored", "utf8");
      const names = await listAgentPrompts(dir);
      assert.deepEqual(names, ["alpha", "beta"]);
    });
  });

  it("listAgentPrompts ignores hidden files", async () => {
    await withTmpDir(async (dir) => {
      await writeFile(join(dir, ".hidden.md"), validPrompt, "utf8");
      await writeFile(join(dir, "visible.md"), validPrompt, "utf8");
      const names = await listAgentPrompts(dir);
      assert.deepEqual(names, ["visible"]);
    });
  });

  it("listAgentPrompts returns empty array when dir does not exist", async () => {
    await withTmpDir(async (dir) => {
      const names = await listAgentPrompts(join(dir, "nonexistent"));
      assert.deepEqual(names, []);
    });
  });

  it("listAgentPrompts skips bad-name files", async () => {
    await withTmpDir(async (dir) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "1bad.md"), validPrompt, "utf8");
      await writeFile(join(dir, "good.md"), validPrompt, "utf8");
      const names = await listAgentPrompts(dir);
      assert.deepEqual(names, ["good"]);
    });
  });
});

describe("bundled agent prompts", () => {
  it("includes the 5 starter roles", async () => {
    const names = await listAgentPrompts(BUNDLED_PROMPTS_DIR);
    for (const role of [
      "analyst",
      "architect",
      "critic",
      "executor",
      "verifier",
    ]) {
      assert.ok(names.includes(role), `missing role: ${role}`);
    }
  });

  it("each starter role parses successfully", async () => {
    const roles: AgentPrompt[] = await Promise.all([
      loadAgentPrompt("architect", BUNDLED_PROMPTS_DIR),
      loadAgentPrompt("critic", BUNDLED_PROMPTS_DIR),
      loadAgentPrompt("executor", BUNDLED_PROMPTS_DIR),
      loadAgentPrompt("analyst", BUNDLED_PROMPTS_DIR),
      loadAgentPrompt("verifier", BUNDLED_PROMPTS_DIR),
    ]);
    for (const r of roles) {
      assert.ok(r.purpose.length > 10, `${r.name} purpose too short`);
      assert.ok(r.body.length > 100, `${r.name} body too short`);
    }
  });
});
