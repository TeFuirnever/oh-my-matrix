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
import { MODEL_TIERS, type ModelTier, type ModelRoutingConfig, type EvidenceStatus } from './types';

// MODEL_TIERS (from types.ts) is the single source of truth for the tier set;
// ModelTier is derived from it, so this allowlist cannot drift out of sync.
function asTier(v: unknown): ModelTier | undefined {
  return typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v)
    ? (v as ModelTier)
    : undefined;
}

const DEFAULT_ROUTING: Required<
  Pick<ModelRoutingConfig, 'defaultTier' | 'initialTurnTier' | 'validationTier'>
> = {
  defaultTier: 'standard',
  initialTurnTier: 'premium',
  validationTier: 'standard',
};

/** Resolve the model tier for the current turn (phase-aware). */
export function resolveModelTier(
  totalContinuations: number,
  evidenceStatus: EvidenceStatus | undefined,
  isSubagent: boolean,
  config?: ModelRoutingConfig,
): ModelTier {
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
export function resolveModelId(
  tier: ModelTier,
  config?: ModelRoutingConfig,
): string | undefined {
  return config?.modelIds?.[tier];
}

/**
 * Detect subagent sessions by the sessionKey marker.
 * OpenClaw subagent keys: agent:<main>:subagent:<sub>
 * Source: openclaw/src/infra/state-migrations.ts:367-369
 */
export function isSubagentSession(sessionKey?: string): boolean {
  return !!sessionKey && sessionKey.includes(':subagent:');
}

/** Extract the parent (main agent) session key from a subagent key. */
export function extractParentSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
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
export function parseModelRouting(raw: unknown): ModelRoutingConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const defaultTier = asTier(r.defaultTier) ?? asTier(r.default_tier);
  if (!defaultTier) return undefined;

  const result: ModelRoutingConfig = { defaultTier };
  const initial = asTier(r.initialTurnTier) ?? asTier(r.initial_turn_tier);
  if (initial) result.initialTurnTier = initial;
  const validation = asTier(r.validationTier) ?? asTier(r.validation_tier);
  if (validation) result.validationTier = validation;
  const subagent = asTier(r.subagentTier) ?? asTier(r.subagent_tier);
  if (subagent) result.subagentTier = subagent;

  const idsRaw = r.modelIds ?? r.model_ids;
  if (typeof idsRaw === 'object' && idsRaw !== null) {
    const ids = idsRaw as Record<string, unknown>;
    const parsed: Partial<Record<ModelTier, string>> = {};
    for (const t of MODEL_TIERS) {
      if (typeof ids[t] === 'string') parsed[t] = ids[t] as string;
    }
    if (Object.keys(parsed).length > 0) result.modelIds = parsed;
  }
  return result;
}
