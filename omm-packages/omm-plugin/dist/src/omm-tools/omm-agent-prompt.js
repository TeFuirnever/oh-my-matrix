import { listAgentPrompts, loadAgentPrompt, } from "../omm-agent-prompts.js";
function normalizeName(value) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error("omm_agent_prompt_get: 'name' is required");
    }
    return value.trim();
}
function normalizeDir(value) {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
/** Execute omm_agent_prompt_get — returns a structured agent prompt by name. */
export async function runOmmAgentPromptGet(input, config = {}) {
    const name = normalizeName(input.name);
    const promptsDir = normalizeDir(config.promptsDir);
    const prompt = await loadAgentPrompt(name, promptsDir);
    return {
        content: [{ type: "text", text: prompt.body }],
        details: {
            name: prompt.name,
            modelTier: prompt.modelTier,
            purpose: prompt.purpose,
        },
    };
}
/** Execute omm_agent_prompt_list — returns the names of all available agent prompts. */
export async function runOmmAgentPromptList(_input = {}, config = {}) {
    const promptsDir = normalizeDir(config.promptsDir);
    const names = await listAgentPrompts(promptsDir);
    return {
        content: [{ type: "text", text: names.join("\n") }],
        details: { names, count: names.length },
    };
}
//# sourceMappingURL=omm-agent-prompt.js.map