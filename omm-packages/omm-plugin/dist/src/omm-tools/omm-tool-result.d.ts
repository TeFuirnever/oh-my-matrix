/** Shared tool result envelope used across all omm tools. */
export interface OmmToolResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Record<string, unknown>;
}
/** Coerce unknown input to a trimmed string or null. */
export declare function normalizeNullableText(value: unknown): string | null;
