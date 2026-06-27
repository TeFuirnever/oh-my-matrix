"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.version = exports.name = exports.id = exports.getAuditFilePath = exports.loadRecentAuditEntries = exports.appendAuditEntry = exports.classifyCommand = exports.decidePermission = void 0;
exports._resetForTest = _resetForTest;
exports.register = register;
const permission_policy_1 = require("./src/permission-policy");
const audit_persister_1 = require("./src/audit-persister");
const logger_1 = require("./src/logger");
// ─── Library re-exports (consumed by @openclaw/autopilot) ───────────────
var permission_policy_2 = require("./src/permission-policy");
Object.defineProperty(exports, "decidePermission", { enumerable: true, get: function () { return permission_policy_2.decidePermission; } });
Object.defineProperty(exports, "classifyCommand", { enumerable: true, get: function () { return permission_policy_2.classifyCommand; } });
var audit_persister_2 = require("./src/audit-persister");
Object.defineProperty(exports, "appendAuditEntry", { enumerable: true, get: function () { return audit_persister_2.appendAuditEntry; } });
Object.defineProperty(exports, "loadRecentAuditEntries", { enumerable: true, get: function () { return audit_persister_2.loadRecentAuditEntries; } });
Object.defineProperty(exports, "getAuditFilePath", { enumerable: true, get: function () { return audit_persister_2.getAuditFilePath; } });
exports.id = 'dynamic-workflows';
exports.name = 'Dynamic Workflows Guard';
exports.version = '0.1.0';
/**
 * before_tool_call priority — higher than autopilot (10) and
 * matrixassistant-audit (9). OpenClaw runs higher-priority hooks first
 * (openclaw/src/plugins/hooks.ts:267,275); block short-circuits lower ones.
 * So the subagent guard blocks BEFORE autopilot's run-scoped handler or the
 * audit hook touches the call.
 */
const BEFORE_TOOL_CALL_PRIORITY = 11;
/**
 * Detect whether a sessionKey belongs to a spawned subagent (e.g. an
 * OpenProse-spawned workflow branch) vs the main interactive session.
 * Mirrors openclaw's convention (src/sessions/session-key-utils.ts):
 * subagent keys carry a `:subagent:` segment, e.g. `agent:main:subagent:<id>`.
 * Inlined because openclaw does not export this helper via the plugin SDK.
 */
function isSubagentSessionKey(sessionKey) {
    return sessionKey.includes(':subagent:');
}
function _resetForTest() {
    // Stateless plugin today — nothing to reset. Kept for API symmetry with
    // autopilot's test harness in case state is added later.
}
function register(api) {
    const config = (api.pluginConfig ?? {});
    if (config.enabled === false) {
        // Loud degradation: this is the ONE safety coupling the extraction can't
        // remove — if THIS plugin is disabled, workflow subagents lose runtime
        // guard. Log loudly so it's visible (a disabled plugin still loads +
        // runs register() in OpenClaw; a host-level disable would not).
        (0, logger_1.logWithContext)('warn', 'dynamic-workflows guard DISABLED by config — workflow subagents will NOT be runtime-guarded against destructive ops', {});
        return;
    }
    const registerHook = api;
    const on = registerHook.on?.bind(api) ?? registerHook.registerHook?.bind(api);
    if (!on) {
        (0, logger_1.logWithContext)('error', 'hook registration API unavailable (api.on and api.registerHook both missing) — dynamic-workflows guard disabled', {});
        return;
    }
    on('before_tool_call', (event, ctx) => {
        const sessionKey = ctx?.sessionKey;
        if (!sessionKey)
            return;
        // Only enforce for subagent sessions. Main sessions and autopilot runs
        // keep their own behavior (autopilot's run-scoped handler covers its runs;
        // the main interactive session keeps normal approval-based behavior).
        if (!isSubagentSessionKey(sessionKey))
            return;
        const toolName = event.toolName;
        const toolKind = event.toolKind;
        const args = Array.isArray(event.args) ? event.args : [];
        const cwd = event.cwd ?? process.cwd();
        const isConfiguredHighRisk = Array.isArray(config.highRiskTools) && config.highRiskTools.includes(toolName);
        const decision = isConfiguredHighRisk
            ? { outcome: 'block', reason: `${toolName} is configured as high-risk tool`, message: `Tool "${toolName}" is blocked by operator config (highRiskTools)` }
            : (0, permission_policy_1.decidePermission)({
                toolName,
                toolKind,
                command: args,
                cwd,
                // No workspace context for ad-hoc subagents → destructive-git
                // containment check is skipped (permission-policy only checks
                // workspace when workflowAllowsDestructiveGit=true), so destructive
                // git falls straight to block. Fail-closed by design.
                workflowAllowsDestructiveGit: false,
            });
        if (decision.outcome !== 'block')
            return; // allow (read_only / workspace_write / network)
        (0, logger_1.logWithContext)('info', 'before_tool_call BLOCKED (subagent guard)', { sessionKey, toolName, reason: decision.reason });
        (0, audit_persister_1.appendAuditEntry)({
            at: Date.now(),
            runId: `subagent:${sessionKey}`,
            toolName,
            commandClass: (0, permission_policy_1.classifyCommand)(toolName, args, toolKind),
            outcome: 'block',
            reason: decision.reason,
            cwd,
        }, cwd);
        return {
            block: true,
            blockReason: decision.message,
        };
    }, { priority: BEFORE_TOOL_CALL_PRIORITY });
}
//# sourceMappingURL=index.js.map