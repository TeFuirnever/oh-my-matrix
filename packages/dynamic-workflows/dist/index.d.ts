/**
 * @openclaw/dynamic-workflows — OpenClaw plugin: subagent runtime guard.
 *
 * Registers `before_tool_call` (priority 11) that fail-closed blocks
 * destructive ops for `:subagent:` sessions (OpenProse-spawned workflow
 * branches). Higher priority than autopilot (10) and matrixassistant-audit
 * (9) so it runs first and block short-circuits the lower-priority handlers.
 * Main sessions + autopilot runs keep their own behavior.
 *
 * The permission primitives (decidePermission, classifyCommand, audit) now
 * live in @openclaw/permission-policy (ADR-013); this plugin imports them.
 */
import type { OpenClawPluginApi } from 'openclaw/dist/plugin-sdk/plugin-runtime';
export declare const id = "dynamic-workflows";
export declare const name = "Dynamic Workflows Guard";
export declare const version = "0.1.0";
export declare function _resetForTest(): void;
export declare function register(api: OpenClawPluginApi): void;
//# sourceMappingURL=index.d.ts.map