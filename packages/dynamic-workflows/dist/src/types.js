"use strict";
/**
 * Shared permission types — consumed by dynamic-workflows (guard) AND by
 * @openclaw/autopilot (run-scoped policy). Pure data; no autopilot coupling.
 *
 * These live here (not in autopilot) because decidePermission + classifyCommand
 * + audit-persister are platform-level safety primitives; autopilot is one
 * consumer, the subagent guard is another. See ADR-012.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map