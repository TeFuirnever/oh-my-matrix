"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runValidationCommands = runValidationCommands;
exports.parseCommandArgs = parseCommandArgs;
/**
 * M5.3: Validation command executor.
 *
 * Executes ValidationCommands via child_process.execFile and returns
 * EvidenceCommandResult[].  Pure I/O — no state, no orchestration.
 *
 * Commands are parsed into [binary, ...args] via parseCommandArgs (quote-aware).
 * Shell features (&&, |, ;) are intentionally unsupported; wrap in a script file.
 *
 * X-15 (Windows .cmd/.bat): Node ≥ 20.12.2 / 24.x blocks execFile of .cmd/.bat
 * without shell:true (CVE-2024-27980 mitigation). We enable shell conditionally:
 *   useShell = isWin && (isCmdLike(bin) || hasNonAscii(bin|args|cwd))
 * mirroring packages/gateway/src/manager.ts:2038-2048. When shell is on, Node
 * auto-quotes the argv array with cmd-safe escaping, preserving injection safety
 * as long as we always pass args as an array (never a pre-joined string).
 */
const child_process_1 = require("child_process");
/**
 * Run each command sequentially and collect results.
 * Never throws — errors are captured as 'failed'/'timeout' results.
 */
async function runValidationCommands(commands, cwd) {
    if (commands.length === 0)
        return [];
    const results = [];
    for (const cmd of commands) {
        const startMs = Date.now();
        try {
            await execCommand(cmd.command, cmd.timeoutMs, cwd);
            results.push({
                id: cmd.id,
                command: cmd.command,
                status: 'passed',
                exitCode: 0, // execFile callback passes null error only on exit 0
                durationMs: Date.now() - startMs,
                summary: '',
            });
        }
        catch (err) {
            const durationMs = Date.now() - startMs;
            const e = err;
            // Detect timeout: process was killed by Node's timeout mechanism (SIGTERM/SIGKILL),
            // or the error code indicates timeout on some platforms.
            // Windows note: SIGTERM/SIGKILL are not POSIX signals — Node uses TerminateProcess()
            // which sets e.killed=true when the Node timeout fires (covered by e.killed===true).
            // External kills via taskkill produce e.killed=undefined and e.signal=null; these
            // cannot be reliably distinguished from normal failures (exit code 1 is also used by
            // `false` and other failing commands), so we do NOT add e.code===1 as a heuristic.
            // (X-2 Windows signal limitation — documented, not patchable without a side-channel.)
            const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT';
            results.push({
                id: cmd.id,
                command: cmd.command,
                status: timedOut ? 'timeout' : 'failed',
                exitCode: typeof e.code === 'number' ? e.code : undefined,
                durationMs,
                summary: (e.stderr ?? e.message ?? String(err)).substring(0, 300),
            });
        }
    }
    return results;
}
/**
 * Parse a command string into [binary, ...args], respecting single and
 * double quotes so paths with spaces are handled correctly on Windows and macOS.
 * Shell features (&&, |, ;, $var) are NOT supported — wrap in a script file.
 */
function parseCommandArgs(command) {
    const args = [];
    let current = '';
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
        }
        else if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        }
        else if (ch === ' ' && !inDouble && !inSingle) {
            if (current) {
                args.push(current);
                current = '';
            }
        }
        else {
            current += ch;
        }
    }
    if (current)
        args.push(current);
    return args;
}
function hasNonAscii(...values) {
    return values.some((s) => [...s].some((c) => c.charCodeAt(0) > 127));
}
function isCmdLike(bin) {
    const lower = bin.toLowerCase();
    return lower.endsWith('.cmd') || lower.endsWith('.bat');
}
function shouldUseShell(bin, args, cwd) {
    if (process.platform !== 'win32')
        return false;
    // Windows: shell is required for .cmd/.bat wrappers (CVE-2024-27980) and
    // beneficial for non-ASCII paths that cmd.exe handles more leniently than
    // the native CreateProcess entry point.
    return isCmdLike(bin) || hasNonAscii(bin, ...args, cwd ?? '');
}
async function execCommand(command, timeoutMs, cwd) {
    const parts = parseCommandArgs(command.trim());
    if (parts.length === 0 || !parts[0]) {
        throw new Error('empty command string');
    }
    const [bin, ...args] = parts;
    const run = (b, a) => new Promise((resolve, reject) => {
        const useShell = shouldUseShell(b, a, cwd);
        (0, child_process_1.execFile)(b, a, { timeout: timeoutMs, cwd, shell: useShell }, (error, _stdout, stderr) => {
            if (error) {
                reject(Object.assign(error, { stderr }));
            }
            else {
                resolve();
            }
        });
    });
    try {
        await run(bin, args);
    }
    catch (err) {
        // Fallback for legacy PATH lookups on Windows where the bare name resolves
        // to ENOENT but the .cmd sibling exists. With conditional shell enabled,
        // this branch is rarely hit; we keep it as belt-and-suspenders for users
        // who wrote `npm test` (bare) and whose Node version still surfaces ENOENT.
        if (process.platform === 'win32' &&
            err.code === 'ENOENT' &&
            !bin.toLowerCase().endsWith('.cmd')) {
            await run(`${bin}.cmd`, args);
            return;
        }
        throw err;
    }
}
//# sourceMappingURL=command-runner.js.map