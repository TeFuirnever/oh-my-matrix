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
export declare const version = "0.2.1";
/** OpenClaw plugin entry point — registers omm tools and lifecycle hooks. */
export declare function register(api: OmmPluginApi): void;
declare const _default: {
    id: string;
    name: string;
    version: string;
    register: typeof register;
};
export default _default;
