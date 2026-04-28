import {
  type AgentPrompt,
  listAgentPrompts,
  loadAgentPrompt,
} from "../omm-agent-prompts.js";

export interface OmmAgentPromptGetInput {
  name?: unknown;
}

export interface OmmAgentPromptConfig {
  promptsDir?: unknown;
}

export interface OmmToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("omm_agent_prompt_get: 'name' is required");
  }
  return value.trim();
}

function normalizeDir(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Execute omm_agent_prompt_get — returns a structured agent prompt by name. */
export async function runOmmAgentPromptGet(
  input: OmmAgentPromptGetInput,
  config: OmmAgentPromptConfig = {},
): Promise<OmmToolResult> {
  const name = normalizeName(input.name);
  const promptsDir = normalizeDir(config.promptsDir);
  const prompt: AgentPrompt = await loadAgentPrompt(name, promptsDir);

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
export async function runOmmAgentPromptList(
  _input: Record<string, unknown> = {},
  config: OmmAgentPromptConfig = {},
): Promise<OmmToolResult> {
  const promptsDir = normalizeDir(config.promptsDir);
  const names = await listAgentPrompts(promptsDir);

  return {
    content: [{ type: "text", text: names.join("\n") }],
    details: { names, count: names.length },
  };
}
