export interface OmmPingInput {
    command?: unknown;
    commandName?: unknown;
    skillName?: unknown;
}
export interface OmmPingConfig {
    stateRoot?: unknown;
}
export interface OmmToolResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Record<string, unknown>;
}
export declare function normalizeNullableText(value: unknown): string | null;
export declare function runOmmPing(input: OmmPingInput, config?: OmmPingConfig): Promise<OmmToolResult>;
