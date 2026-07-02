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

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function getCurrentLevel(): LogLevel {
  const env = typeof process !== 'undefined'
    ? (process.env.AUTOPILOT_LOG_LEVEL ?? process.env.LOG_LEVEL)
    : undefined;
  if (env && env in LEVEL_PRIORITY) return env as LogLevel;
  return 'info';
}

function isJsonFormat(): boolean {
  return typeof process !== 'undefined' &&
    process.env.AUTOPILOT_LOG_FORMAT === 'json';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getCurrentLevel()];
}

function emitJson(level: Exclude<LogLevel, 'silent'>, msg: string, ctx?: Record<string, unknown>): void {
  const record: Record<string, unknown> = { ts: Date.now(), level, msg, ...ctx };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // Circular ref or BigInt in ctx — the logger must never throw into a hook.
    line = JSON.stringify({ ts: record.ts, level, msg, ctxError: 'unserializable' });
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function emitText(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

/**
 * Split variadic log args into a message string + a merged context object.
 * Object args have their structure PRESERVED (merged into ctx) instead of being
 * flattened to "[object Object]"; primitive/array args join into the message.
 * This is what lets JSON-mode `log('x', { runId })` emit a real runId field
 * instead of a lost blob. Text mode is unaffected (it passes raw args through).
 */
function splitArgs(args: unknown[]): { msg: string; ctx: Record<string, unknown> } {
  const parts: string[] = [];
  let ctx: Record<string, unknown> = {};
  for (const a of args) {
    // Arrays are object-typed but flatten poorly into ctx ({0:..,1:..}); keep
    // them in the message like before. Only plain objects merge into ctx.
    if (a !== null && typeof a === 'object' && !Array.isArray(a)) {
      ctx = { ...ctx, ...(a as Record<string, unknown>) };
    } else {
      parts.push(String(a));
    }
  }
  return { msg: parts.join(' '), ctx };
}

/** Log an informational message (gated by AUTOPILOT_LOG_LEVEL >= info) */
export function log(...args: unknown[]): void {
  if (!shouldLog('info')) return;
  if (isJsonFormat()) { const { msg, ctx } = splitArgs(args); emitJson('info', msg, ctx); }
  else emitText('info', args);
}

/** Log a warning message (gated by AUTOPILOT_LOG_LEVEL >= warn) */
export function warn(...args: unknown[]): void {
  if (!shouldLog('warn')) return;
  if (isJsonFormat()) { const { msg, ctx } = splitArgs(args); emitJson('warn', msg, ctx); }
  else emitText('warn', args);
}

/** Log an error message (gated by AUTOPILOT_LOG_LEVEL >= error) */
export function error(...args: unknown[]): void {
  if (!shouldLog('error')) return;
  if (isJsonFormat()) { const { msg, ctx } = splitArgs(args); emitJson('error', msg, ctx); }
  else emitText('error', args);
}

/**
 * Log a structured message with additional context fields.
 * In JSON mode: emits { ts, level, msg, ...ctx }.
 * In text mode: emits "[level] msg {ctx}" via the appropriate console method.
 */
export function logWithContext(
  level: Exclude<LogLevel, 'silent'>,
  msg: string,
  ctx: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  if (isJsonFormat()) {
    emitJson(level, msg, ctx);
  } else {
    const ctxStr = Object.entries(ctx).map(([k, v]) => `${k}=${String(v)}`).join(' ');
    emitText(level, [`[${level}] ${msg}`, ctxStr]);
  }
}
