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

export type HookHandler = (
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface LoadedHook {
  /** Event name the hook is bound to. */
  event: string;
  /** Source file path (absolute), useful for diagnostics. */
  source: string;
  /** Async-safe handler. */
  handler: HookHandler;
}

export interface HookLoadIssue {
  source: string;
  error: string;
}

export interface LoadHooksResult {
  hooks: LoadedHook[];
  issues: HookLoadIssue[];
}

function isHookHandler(value: unknown): value is HookHandler {
  return typeof value === "function";
}

/**
 * Load all hook modules in `dir` whose `event` export matches `eventName`.
 * When `eventName` is omitted, every valid hook is returned regardless of
 * event binding.
 */
export async function loadHooks(
  dir: string,
  eventName?: string,
): Promise<LoadHooksResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { hooks: [], issues: [] };
  }

  const hooks: LoadedHook[] = [];
  const issues: HookLoadIssue[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".mjs") || entry.startsWith(".")) continue;
    const source = join(dir, entry);
    try {
      const mod = (await import(pathToFileURL(source).href)) as Record<
        string,
        unknown
      >;
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

export interface HookDispatchOutcome {
  source: string;
  ok: boolean;
  error?: string;
  /** Return value when the handler succeeded. Undefined on failure. */
  value?: unknown;
}

/**
 * Run every hook bound to `eventName` in `dir`, in parallel. Each handler's
 * exception is captured per-hook so a single misbehaving hook cannot block
 * the others. Returns one outcome per hook plus any load-time issues.
 */
export async function dispatchHooks(
  dir: string,
  eventName: string,
  args: Record<string, unknown>,
): Promise<{ outcomes: HookDispatchOutcome[]; issues: HookLoadIssue[] }> {
  const { hooks, issues } = await loadHooks(dir, eventName);
  const outcomes = await Promise.all(
    hooks.map(async (h): Promise<HookDispatchOutcome> => {
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
