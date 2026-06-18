import type { ValidationCommand, EvidenceCommandResult } from './types';
/**
 * Run each command sequentially and collect results.
 * Never throws — errors are captured as 'failed'/'timeout' results.
 */
export declare function runValidationCommands(commands: ValidationCommand[], cwd?: string): Promise<EvidenceCommandResult[]>;
/**
 * Parse a command string into [binary, ...args], respecting single and
 * double quotes so paths with spaces are handled correctly on Windows and macOS.
 * Shell features (&&, |, ;, $var) are NOT supported — wrap in a script file.
 */
export declare function parseCommandArgs(command: string): string[];
//# sourceMappingURL=command-runner.d.ts.map