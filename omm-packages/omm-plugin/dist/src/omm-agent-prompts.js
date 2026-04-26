/**
 * Agent prompt loader — read role definitions from markdown files with
 * minimal frontmatter (`name`, `model_tier`, `purpose`).
 *
 * Skills and host integrations call `loadAgentPrompt("architect")` instead
 * of inlining persona text. Default search path is the bundled
 * `omm-skills/agent-prompts/` directory; callers can override for tests
 * or out-of-bundle prompt sets.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const TIERS = new Set(["haiku", "sonnet", "opus"]);
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
function defaultPromptsDir() {
    // Compiled to dist/src/omm-agent-prompts.js; resolve up to package root,
    // then over to the omm-skills/agent-prompts directory in the suite layout.
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "..", "..", "omm-skills", "agent-prompts");
}
/**
 * Parse a markdown file with `---`-fenced YAML frontmatter. Only the three
 * fields (`name`, `model_tier`, `purpose`) are recognized; unknown keys
 * pass through silently as we want forward-compatibility for additional
 * metadata without breaking existing loaders.
 */
export function parseAgentPrompt(raw) {
    const fence = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fence) {
        throw new Error("agent prompt is missing --- frontmatter fence");
    }
    const [, frontmatterRaw, body] = fence;
    const fields = {};
    for (const line of frontmatterRaw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === "")
            continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx <= 0) {
            throw new Error(`invalid frontmatter line: ${line}`);
        }
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();
        fields[key] = value;
    }
    const name = fields.name;
    if (!name || !NAME_PATTERN.test(name)) {
        throw new Error(`agent prompt name must match /^[a-z][a-z0-9-]*$/, got: ${name ?? "(missing)"}`);
    }
    const tierRaw = fields.model_tier;
    if (!tierRaw || !TIERS.has(tierRaw)) {
        throw new Error(`agent prompt model_tier must be one of haiku|sonnet|opus, got: ${tierRaw ?? "(missing)"}`);
    }
    const purpose = fields.purpose;
    if (!purpose) {
        throw new Error("agent prompt purpose is required");
    }
    const trimmedBody = body.trim();
    if (trimmedBody === "") {
        throw new Error("agent prompt body is empty");
    }
    return { name, modelTier: tierRaw, purpose, body: trimmedBody };
}
/** Load a single agent prompt by role name. Throws if the file is missing or malformed. */
export async function loadAgentPrompt(name, promptsDir = defaultPromptsDir()) {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`invalid agent prompt name: ${name}`);
    }
    const path = join(promptsDir, `${name}.md`);
    const raw = await readFile(path, "utf8");
    const parsed = parseAgentPrompt(raw);
    if (parsed.name !== name) {
        throw new Error(`agent prompt frontmatter name "${parsed.name}" does not match filename "${name}"`);
    }
    return parsed;
}
/**
 * List all available agent prompt names by scanning `*.md` files in the
 * directory. Returns names sorted ascending. Hidden files and other
 * extensions are ignored.
 */
export async function listAgentPrompts(promptsDir = defaultPromptsDir()) {
    let entries;
    try {
        entries = await readdir(promptsDir);
    }
    catch {
        return [];
    }
    return entries
        .filter((f) => f.endsWith(".md") && !f.startsWith("."))
        .map((f) => f.slice(0, -3))
        .filter((name) => NAME_PATTERN.test(name))
        .sort();
}
//# sourceMappingURL=omm-agent-prompts.js.map