/**
 * M-1: Autopilot Logger — gated console output with optional JSON format.
 *
 * All autopilot logging should go through this module instead of raw
 * console.log/warn/error. Two env vars control behavior:
 *
 *   AUTOPILOT_LOG_LEVEL  — verbosity: debug | info (default) | warn | error | silent
 *   AUTOPILOT_LOG_FORMAT — output format: text (default) | json
 *
 * JSON mode emits one JSON object per line: { ts, level, msg, ...ctx }
 * Text mode emits plain string args (backward-compatible with existing behavior).
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
/** Log an informational message (gated by AUTOPILOT_LOG_LEVEL >= info) */
export declare function log(...args: unknown[]): void;
/** Log a warning message (gated by AUTOPILOT_LOG_LEVEL >= warn) */
export declare function warn(...args: unknown[]): void;
/** Log an error message (gated by AUTOPILOT_LOG_LEVEL >= error) */
export declare function error(...args: unknown[]): void;
/**
 * Log a structured message with additional context fields.
 * In JSON mode: emits { ts, level, msg, ...ctx }.
 * In text mode: emits "[level] msg {ctx}" via the appropriate console method.
 */
export declare function logWithContext(level: Exclude<LogLevel, 'silent'>, msg: string, ctx: Record<string, unknown>): void;
export {};
//# sourceMappingURL=logger.d.ts.map