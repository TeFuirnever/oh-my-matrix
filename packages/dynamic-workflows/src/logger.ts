/**
 * Minimal structured logger for the dynamic-workflows guard plugin.
 * Mirrors @oh-my-matrix/autopilot's logger interface (log/warn/error/logWithContext)
 * so the guard code is portable between the two. Env-gated:
 *
 *   DYNAMIC_WORKFLOWS_LOG_LEVEL  — debug | info (default) | warn | error | silent
 *   DYNAMIC_WORKFLOWS_LOG_FORMAT — text (default) | json
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
    ? (process.env.DYNAMIC_WORKFLOWS_LOG_LEVEL ?? process.env.LOG_LEVEL)
    : undefined;
  if (env && env in LEVEL_PRIORITY) return env as LogLevel;
  return 'info';
}

function isJsonFormat(): boolean {
  return typeof process !== 'undefined' &&
    process.env.DYNAMIC_WORKFLOWS_LOG_FORMAT === 'json';
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
    // Circular ref or BigInt in ctx — the logger must never throw into the guard hook.
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

function splitArgs(args: unknown[]): { msg: string; ctx: Record<string, unknown> } {
  const parts: string[] = [];
  let ctx: Record<string, unknown> = {};
  for (const a of args) {
    if (a !== null && typeof a === 'object' && !Array.isArray(a)) {
      ctx = { ...ctx, ...(a as Record<string, unknown>) };
    } else {
      parts.push(String(a));
    }
  }
  return { msg: parts.join(' '), ctx };
}

export function log(...args: unknown[]): void {
  if (!shouldLog('info')) return;
  if (isJsonFormat()) {
    const { msg, ctx } = splitArgs(args);
    emitJson('info', msg, ctx);
  } else emitText('info', args);
}

export function warn(...args: unknown[]): void {
  if (!shouldLog('warn')) return;
  if (isJsonFormat()) {
    const { msg, ctx } = splitArgs(args);
    emitJson('warn', msg, ctx);
  } else emitText('warn', args);
}

export function error(...args: unknown[]): void {
  if (!shouldLog('error')) return;
  if (isJsonFormat()) {
    const { msg, ctx } = splitArgs(args);
    emitJson('error', msg, ctx);
  } else emitText('error', args);
}

/** Structured log: JSON `{ts,level,msg,...ctx}` in json mode, `[level] msg k=v` in text mode. */
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
