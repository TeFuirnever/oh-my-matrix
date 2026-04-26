/**
 * Dynamic hook loader — scan a directory for `.mjs` hook modules, filter
 * by event name, and dispatch in parallel with isolated error capture.
 *
 * A hook module exports two named values:
 *   export const event = "session_start";   // event name to bind to
 *   export const handler = async (args) => { ... };
 *
 * The loader is fail-soft on every level:
 *   - missing dir → empty hook list
 *   - module that fails to import → skipped (logged via the result)
 *   - hook handler that throws → captured per-hook, other hooks still run
 *
 * This keeps the hook system from becoming a single point of failure for
 * the whole session lifecycle.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
function isHookHandler(value) {
  return typeof value === "function";
}
/**
 * Load all hook modules in `dir` whose `event` export matches `eventName`.
 * When `eventName` is omitted, every valid hook is returned regardless of
 * event binding.
 */
export async function loadHooks(dir, eventName) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { hooks: [], issues: [] };
  }
  const hooks = [];
  const issues = [];
  for (const entry of entries) {
    if (!entry.endsWith(".mjs") || entry.startsWith(".")) continue;
    const source = join(dir, entry);
    try {
      const mod = await import(pathToFileURL(source).href);
      const event = mod.event;
      const handler = mod.handler;
      if (typeof event !== "string" || event.trim() === "") {
        issues.push({
          source,
          error: "hook module must export `event` as a non-empty string",
        });
        continue;
      }
      if (!isHookHandler(handler)) {
        issues.push({
          source,
          error: "hook module must export `handler` as a function",
        });
        continue;
      }
      if (eventName !== undefined && event !== eventName) continue;
      hooks.push({ event, source, handler });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({ source, error: `import failed: ${message}` });
    }
  }
  return { hooks, issues };
}
/**
 * Run every hook bound to `eventName` in `dir`, in parallel. Each handler's
 * exception is captured per-hook so a single misbehaving hook cannot block
 * the others. Returns one outcome per hook plus any load-time issues.
 */
export async function dispatchHooks(dir, eventName, args) {
  const { hooks, issues } = await loadHooks(dir, eventName);
  const outcomes = await Promise.all(
    hooks.map(async (h) => {
      try {
        const value = await h.handler(args);
        return { source: h.source, ok: true, value };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { source: h.source, ok: false, error };
      }
    }),
  );
  return { outcomes, issues };
}
//# sourceMappingURL=omm-hook-loader.js.map
