import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOmmAgentPromptGet, runOmmAgentPromptList, } from "./omm-agent-prompt.js";
const SAMPLE_ARCHITECT = `---
name: architect
model_tier: opus
purpose: Design system architecture and surface trade-offs
---

You are a senior architect.`;
const SAMPLE_REVIEWER = `---
name: reviewer
model_tier: sonnet
purpose: Critique code changes for correctness and clarity
---

You are a code reviewer.`;
async function setupDir() {
    const dir = await mkdtemp(join(tmpdir(), "omm-agent-prompt-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "architect.md"), SAMPLE_ARCHITECT, "utf8");
    await writeFile(join(dir, "reviewer.md"), SAMPLE_REVIEWER, "utf8");
    return dir;
}
test("omm_agent_prompt_get returns body + structured details", async () => {
    const dir = await setupDir();
    try {
        const result = await runOmmAgentPromptGet({ name: "architect" }, { promptsDir: dir });
        assert.equal(result.content[0]?.text, "You are a senior architect.");
        assert.deepEqual(result.details, {
            name: "architect",
            modelTier: "opus",
            purpose: "Design system architecture and surface trade-offs",
        });
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("omm_agent_prompt_list returns sorted names", async () => {
    const dir = await setupDir();
    try {
        const result = await runOmmAgentPromptList({}, { promptsDir: dir });
        assert.deepEqual(result.details.names, ["architect", "reviewer"]);
        assert.equal(result.details.count, 2);
        assert.equal(result.content[0]?.text, "architect\nreviewer");
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("omm_agent_prompt_get rejects empty name", async () => {
    const dir = await setupDir();
    try {
        await assert.rejects(() => runOmmAgentPromptGet({ name: "" }, { promptsDir: dir }), /name.*required/i);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("omm_agent_prompt_get rejects invalid name pattern", async () => {
    const dir = await setupDir();
    try {
        await assert.rejects(() => runOmmAgentPromptGet({ name: "Bad-Name" }, { promptsDir: dir }), /invalid agent prompt name/);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("omm_agent_prompt_get throws when file missing", async () => {
    const dir = await setupDir();
    try {
        await assert.rejects(() => runOmmAgentPromptGet({ name: "nonexistent" }, { promptsDir: dir }));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("omm_agent_prompt_list returns empty for missing dir", async () => {
    const result = await runOmmAgentPromptList({}, { promptsDir: "/nonexistent/path/does-not-exist" });
    assert.deepEqual(result.details.names, []);
    assert.equal(result.details.count, 0);
});
//# sourceMappingURL=omm-agent-prompt.test.js.map