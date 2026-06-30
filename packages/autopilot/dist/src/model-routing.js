"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveModelTier = resolveModelTier;
exports.resolveModelId = resolveModelId;
exports.isSubagentSession = isSubagentSession;
exports.extractParentSessionKey = extractParentSessionKey;
exports.parseModelRouting = parseModelRouting;
/**
 * Model tier routing for autopilot.
 *
 * Pure functions — no side effects, no I/O. Gateway consumes the resolved
 * model via the before_model_resolve hook (modelOverride).
 *
 * Routing priority:
 * 1. Subagent with explicit subagentTier -> subagentTier
 * 2. Evidence gate running (validation phase) -> validationTier
 * 3. Initial turns (totalContinuations <= 1) -> initialTurnTier
 * 4. Otherwise -> defaultTier
 *
 * If modelIds[tier] is unset, resolveModelId returns undefined and no
 * modelOverride is emitted — the session inherits its declared model.
 */
const types_1 = require("./types");
// MODEL_TIERS (from types.ts) is the single source of truth for the tier set;
// ModelTier is derived from it, so this allowlist cannot drift out of sync.
function asTier(v) {
    return typeof v === 'string' && types_1.MODEL_TIERS.includes(v)
        ? v
        : undefined;
}
const DEFAULT_ROUTING = {
    defaultTier: 'standard',
    initialTurnTier: 'premium',
    validationTier: 'standard',
};
/** Resolve the model tier for the current turn (phase-aware). */
function resolveModelTier(totalContinuations, evidenceStatus, isSubagent, config) {
    if (isSubagent && config?.subagentTier) {
        return config.subagentTier;
    }
    if (evidenceStatus === 'running') {
        return config?.validationTier ?? DEFAULT_ROUTING.validationTier;
    }
    if (totalContinuations <= 1) {
        return config?.initialTurnTier ?? DEFAULT_ROUTING.initialTurnTier;
    }
    return config?.defaultTier ?? DEFAULT_ROUTING.defaultTier;
}
/** Resolve a concrete model ID for a tier. undefined => no override (inherit). */
function resolveModelId(tier, config) {
    return config?.modelIds?.[tier];
}
/**
 * Detect subagent sessions by the sessionKey marker.
 * OpenClaw subagent keys: agent:<main>:subagent:<sub>
 * Source: openclaw/src/infra/state-migrations.ts:367-369
 */
function isSubagentSession(sessionKey) {
    return !!sessionKey && sessionKey.includes(':subagent:');
}
/** Extract the parent (main agent) session key from a subagent key. */
function extractParentSessionKey(sessionKey) {
    if (!sessionKey)
        return undefined;
    const idx = sessionKey.indexOf(':subagent:');
    // idx > 0 (not >= 0) is load-bearing: a malformed ':subagent:'-prefixed key
    // has no parent prefix and must yield undefined, not an empty string.
    return idx > 0 ? sessionKey.substring(0, idx) : undefined;
}
/**
 * Parse a ModelRoutingConfig from raw plugin config (camelCase) OR
 * WORKFLOW.md front-matter (snake_case). Accepts both key styles so one
 * parser serves openclaw.plugin.json configSchema and WORKFLOW.md.
 * Returns undefined when defaultTier is absent/invalid (=> no routing).
 */
function parseModelRouting(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const r = raw;
    const defaultTier = asTier(r.defaultTier) ?? asTier(r.default_tier);
    if (!defaultTier)
        return undefined;
    const result = { defaultTier };
    const initial = asTier(r.initialTurnTier) ?? asTier(r.initial_turn_tier);
    if (initial)
        result.initialTurnTier = initial;
    const validation = asTier(r.validationTier) ?? asTier(r.validation_tier);
    if (validation)
        result.validationTier = validation;
    const subagent = asTier(r.subagentTier) ?? asTier(r.subagent_tier);
    if (subagent)
        result.subagentTier = subagent;
    const idsRaw = r.modelIds ?? r.model_ids;
    if (typeof idsRaw === 'object' && idsRaw !== null) {
        const ids = idsRaw;
        const parsed = {};
        for (const t of types_1.MODEL_TIERS) {
            if (typeof ids[t] === 'string')
                parsed[t] = ids[t];
        }
        if (Object.keys(parsed).length > 0)
            result.modelIds = parsed;
    }
    return result;
}
//# sourceMappingURL=model-routing.js.map