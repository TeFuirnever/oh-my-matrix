import { type OmmErrorCode } from "../omm-error-codes.js";
import type { OmmToolResult } from "./omm-ping.js";
export interface OmmStateWriteInput {
    key?: unknown;
    value?: unknown;
}
export interface OmmStateReadInput {
    key?: unknown;
}
export interface OmmStateConfig {
    stateRoot?: string;
}
/** Whitelist key to prevent path traversal and filesystem injection. */
export declare function sanitizeStateKey(raw: unknown): {
    ok: boolean;
    key?: string;
    error?: string;
    code?: OmmErrorCode;
};
/** Write validated JSON state by key with atomic tmp+rename. */
export declare function runOmmStateWrite(input: OmmStateWriteInput, config?: OmmStateConfig): Promise<OmmToolResult>;
/** Read JSON state by key. Returns null content if not found. */
export declare function runOmmStateRead(input: OmmStateReadInput, config?: OmmStateConfig): Promise<OmmToolResult>;
/** List all state keys. */
export declare function runOmmStateList(_input: Record<string, unknown>, config?: OmmStateConfig): Promise<OmmToolResult>;
