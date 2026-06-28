"use strict";
/**
 * @openclaw/permission-policy — shared permission policy primitives.
 *
 * Pure library (NOT a plugin — no openclaw.plugin.json, no hooks, no register()).
 * Consumed by:
 *   - @openclaw/autopilot (run-scoped permission policy + audit)
 *   - @openclaw/dynamic-workflows (subagent guard)
 * Single source of truth for the destructive-op classification + audit trail.
 * See ADR-013.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAuditFilePath = exports.loadRecentAuditEntries = exports.appendAuditEntry = exports.tokenizeShell = exports.extractCommandSegments = exports.decidePermissionForEvent = exports.classifyCommand = exports.decidePermission = void 0;
// ─── Permission policy ──────────────────────────────────────────────────
var permission_policy_1 = require("./src/permission-policy");
Object.defineProperty(exports, "decidePermission", { enumerable: true, get: function () { return permission_policy_1.decidePermission; } });
Object.defineProperty(exports, "classifyCommand", { enumerable: true, get: function () { return permission_policy_1.classifyCommand; } });
Object.defineProperty(exports, "decidePermissionForEvent", { enumerable: true, get: function () { return permission_policy_1.decidePermissionForEvent; } });
Object.defineProperty(exports, "extractCommandSegments", { enumerable: true, get: function () { return permission_policy_1.extractCommandSegments; } });
Object.defineProperty(exports, "tokenizeShell", { enumerable: true, get: function () { return permission_policy_1.tokenizeShell; } });
// ─── Audit persistence ──────────────────────────────────────────────────
var audit_persister_1 = require("./src/audit-persister");
Object.defineProperty(exports, "appendAuditEntry", { enumerable: true, get: function () { return audit_persister_1.appendAuditEntry; } });
Object.defineProperty(exports, "loadRecentAuditEntries", { enumerable: true, get: function () { return audit_persister_1.loadRecentAuditEntries; } });
Object.defineProperty(exports, "getAuditFilePath", { enumerable: true, get: function () { return audit_persister_1.getAuditFilePath; } });
//# sourceMappingURL=index.js.map