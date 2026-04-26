import { resolveOmmStateRoot } from "./omm-config.js";
export { resolveOmmStateRoot };
export interface OmmSmokeRecord {
    message: string;
    commandName: string | null;
    skillName: string | null;
    createdAt: string;
}
/** Atomically write a JSON record to the omm state directory (tmp + rename). */
export declare function writeOmmSmokeRecord(record: OmmSmokeRecord, configRoot?: unknown): Promise<string>;
