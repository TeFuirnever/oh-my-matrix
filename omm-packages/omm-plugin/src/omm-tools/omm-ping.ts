import { writeOmmSmokeRecord } from "../omm-state.js";

export interface OmmPingInput {
  command?: unknown;
  commandName?: unknown;
  skillName?: unknown;
}

export interface OmmPingConfig {
  stateRoot?: unknown;
}

export interface OmmToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function normalizeMessage(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : "ping";
}

function normalizeNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export async function runOmmPing(
  input: OmmPingInput,
  config: OmmPingConfig = {},
): Promise<OmmToolResult> {
  const record = {
    message: normalizeMessage(input.command),
    commandName: normalizeNullableText(input.commandName),
    skillName: normalizeNullableText(input.skillName),
    createdAt: new Date().toISOString(),
  };
  const path = await writeOmmSmokeRecord(record, config.stateRoot);

  return {
    content: [
      {
        type: "text",
        text: `omm pong: ${record.message}`,
      },
    ],
    details: {
      path,
      record,
    },
  };
}
