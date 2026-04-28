/**
 * Plugin/MCP API contract version. Hosts that depend on a specific shape
 * for tool results, error envelopes, or state semantics should compare
 * against this constant rather than parsing `package.json` version strings.
 *
 * Bump on breaking surface changes (tool signatures, error envelope, state
 * file layout). Patch and minor releases keep `API_VERSION` stable.
 *
 * @see docs/contracts/error-codes.md
 * @since 0.3.0
 */
export declare const OMM_API_VERSION: "0.3";
interface OmmPluginApi {
    registerTool?: (tool: {
        name: string;
        label?: string;
        description?: string;
        parameters?: Record<string, unknown>;
        execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (delta: string) => void) => Promise<unknown>;
    }, options?: {
        optional?: boolean;
        name?: string;
    }) => void;
    on?: (eventName: string, handler: (...args: unknown[]) => unknown) => void;
    config?: Record<string, unknown>;
}
export declare const id = "omm";
export declare const name = "omm";
export declare const version = "0.3.0-beta.1";
/** OpenClaw plugin entry point — registers omm tools and lifecycle hooks. */
export declare function register(api: OmmPluginApi): void;
declare const _default: {
    id: string;
    name: string;
    version: string;
    register: typeof register;
};
export default _default;
