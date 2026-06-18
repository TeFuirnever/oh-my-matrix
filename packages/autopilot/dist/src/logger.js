"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
exports.warn = warn;
exports.error = error;
exports.logWithContext = logWithContext;
const LEVEL_PRIORITY = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};
function getCurrentLevel() {
    const env = typeof process !== 'undefined'
        ? (process.env.AUTOPILOT_LOG_LEVEL ?? process.env.LOG_LEVEL)
        : undefined;
    if (env && env in LEVEL_PRIORITY)
        return env;
    return 'info';
}
function isJsonFormat() {
    return typeof process !== 'undefined' &&
        process.env.AUTOPILOT_LOG_FORMAT === 'json';
}
function shouldLog(level) {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getCurrentLevel()];
}
function emitJson(level, msg, ctx) {
    const record = { ts: Date.now(), level, msg, ...ctx };
    const line = JSON.stringify(record);
    if (level === 'error')
        console.error(line);
    else if (level === 'warn')
        console.warn(line);
    else
        console.log(line);
}
function emitText(level, args) {
    if (level === 'error')
        console.error(...args);
    else if (level === 'warn')
        console.warn(...args);
    else
        console.log(...args);
}
/** Log an informational message (gated by AUTOPILOT_LOG_LEVEL >= info) */
function log(...args) {
    if (!shouldLog('info'))
        return;
    if (isJsonFormat())
        emitJson('info', args.map(String).join(' '));
    else
        emitText('info', args);
}
/** Log a warning message (gated by AUTOPILOT_LOG_LEVEL >= warn) */
function warn(...args) {
    if (!shouldLog('warn'))
        return;
    if (isJsonFormat())
        emitJson('warn', args.map(String).join(' '));
    else
        emitText('warn', args);
}
/** Log an error message (gated by AUTOPILOT_LOG_LEVEL >= error) */
function error(...args) {
    if (!shouldLog('error'))
        return;
    if (isJsonFormat())
        emitJson('error', args.map(String).join(' '));
    else
        emitText('error', args);
}
/**
 * Log a structured message with additional context fields.
 * In JSON mode: emits { ts, level, msg, ...ctx }.
 * In text mode: emits "[level] msg {ctx}" via the appropriate console method.
 */
function logWithContext(level, msg, ctx) {
    if (!shouldLog(level))
        return;
    if (isJsonFormat()) {
        emitJson(level, msg, ctx);
    }
    else {
        const ctxStr = Object.entries(ctx).map(([k, v]) => `${k}=${String(v)}`).join(' ');
        emitText(level, [`[${level}] ${msg}`, ctxStr]);
    }
}
//# sourceMappingURL=logger.js.map