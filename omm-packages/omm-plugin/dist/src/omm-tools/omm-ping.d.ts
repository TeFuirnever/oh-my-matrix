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
/** Coerce unknown input to a trimmed string or null. */
export declare function normalizeNullableText(value: unknown): string | null;
/** Execute omm_ping tool — writes a smoke record and returns a pong response. */
export declare function runOmmPing(
  input: OmmPingInput,
  config?: OmmPingConfig,
): Promise<OmmToolResult>;
