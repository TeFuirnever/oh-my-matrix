import { writeOmmSmokeRecord } from "../omm-state.js";
function normalizeMessage(value) {
    return typeof value === "string" && value.trim() !== "" ? value : "ping";
}
/** Coerce unknown input to a trimmed string or null. */
export function normalizeNullableText(value) {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}
/** Execute omm_ping tool — writes a smoke record and returns a pong response. */
export async function runOmmPing(input, config = {}) {
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
//# sourceMappingURL=omm-ping.js.map