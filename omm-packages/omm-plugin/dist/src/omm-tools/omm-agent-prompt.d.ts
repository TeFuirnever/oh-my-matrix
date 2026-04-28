export interface OmmAgentPromptGetInput {
    name?: unknown;
}
export interface OmmAgentPromptConfig {
    promptsDir?: unknown;
}
export interface OmmToolResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Record<string, unknown>;
}
/** Execute omm_agent_prompt_get — returns a structured agent prompt by name. */
export declare function runOmmAgentPromptGet(input: OmmAgentPromptGetInput, config?: OmmAgentPromptConfig): Promise<OmmToolResult>;
/** Execute omm_agent_prompt_list — returns the names of all available agent prompts. */
export declare function runOmmAgentPromptList(_input?: Record<string, unknown>, config?: OmmAgentPromptConfig): Promise<OmmToolResult>;
