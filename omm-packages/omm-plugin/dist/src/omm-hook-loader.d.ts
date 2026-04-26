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
/**
 * Load all hook modules in `dir` whose `event` export matches `eventName`.
 * When `eventName` is omitted, every valid hook is returned regardless of
 * event binding.
 */
export declare function loadHooks(
  dir: string,
  eventName?: string,
): Promise<LoadHooksResult>;
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
export declare function dispatchHooks(
  dir: string,
  eventName: string,
  args: Record<string, unknown>,
): Promise<{
  outcomes: HookDispatchOutcome[];
  issues: HookLoadIssue[];
}>;
