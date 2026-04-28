export type AgentModelTier = "haiku" | "sonnet" | "opus";
export interface AgentPrompt {
    name: string;
    modelTier: AgentModelTier;
    purpose: string;
    body: string;
}
/**
 * Parse a markdown file with `---`-fenced YAML frontmatter. Only the three
 * fields (`name`, `model_tier`, `purpose`) are recognized; unknown keys
 * pass through silently as we want forward-compatibility for additional
 * metadata without breaking existing loaders.
 */
export declare function parseAgentPrompt(raw: string): AgentPrompt;
/** Load a single agent prompt by role name. Throws if the file is missing or malformed. */
export declare function loadAgentPrompt(name: string, promptsDir?: string): Promise<AgentPrompt>;
/**
 * List all available agent prompt names by scanning `*.md` files in the
 * directory. Returns names sorted ascending. Hidden files and other
 * extensions are ignored.
 */
export declare function listAgentPrompts(promptsDir?: string): Promise<string[]>;
/**
 * Resolve the prompts directory and verify a sentinel prompt is loadable.
 * Used at plugin startup to make host-layout drift visible — without this,
 * `listAgentPrompts` swallows ENOENT and returns an empty array, hiding
 * misconfiguration until a user-visible failure.
 *
 * Logs the resolved path and a warning if the sentinel is missing. The
 * sentinel is the bundled `architect.md` (one of 5 ships-by-default prompts).
 */
export declare function verifyAgentPromptsAvailable(promptsDir?: string, sentinel?: string): Promise<{
    resolvedDir: string;
    sentinelFound: boolean;
}>;
