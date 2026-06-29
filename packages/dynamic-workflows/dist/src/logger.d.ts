/**
 * Minimal structured logger for the dynamic-workflows guard plugin.
 * Mirrors @oh-my-matrix/autopilot's logger interface (log/warn/error/logWithContext)
 * so the guard code is portable between the two. Env-gated:
 *
 *   DYNAMIC_WORKFLOWS_LOG_LEVEL  — debug | info (default) | warn | error | silent
 *   DYNAMIC_WORKFLOWS_LOG_FORMAT — text (default) | json
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export declare function log(...args: unknown[]): void;
export declare function warn(...args: unknown[]): void;
export declare function error(...args: unknown[]): void;
/** Structured log: JSON `{ts,level,msg,...ctx}` in json mode, `[level] msg k=v` in text mode. */
export declare function logWithContext(level: Exclude<LogLevel, 'silent'>, msg: string, ctx: Record<string, unknown>): void;
export {};
//# sourceMappingURL=logger.d.ts.map