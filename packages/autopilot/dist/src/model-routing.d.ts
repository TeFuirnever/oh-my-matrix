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
import { type ModelTier, type ModelRoutingConfig, type EvidenceStatus } from './types';
/** Resolve the model tier for the current turn (phase-aware). */
export declare function resolveModelTier(totalContinuations: number, evidenceStatus: EvidenceStatus | undefined, isSubagent: boolean, config?: ModelRoutingConfig): ModelTier;
/** Resolve a concrete model ID for a tier. undefined => no override (inherit). */
export declare function resolveModelId(tier: ModelTier, config?: ModelRoutingConfig): string | undefined;
/**
 * Detect subagent sessions by the sessionKey marker.
 * OpenClaw subagent keys: agent:<main>:subagent:<sub>
 * Source: openclaw/src/infra/state-migrations.ts:367-369
 */
export declare function isSubagentSession(sessionKey?: string): boolean;
/** Extract the parent (main agent) session key from a subagent key. */
export declare function extractParentSessionKey(sessionKey?: string): string | undefined;
/**
 * Parse a ModelRoutingConfig from raw plugin config (camelCase) OR
 * WORKFLOW.md front-matter (snake_case). Accepts both key styles so one
 * parser serves openclaw.plugin.json configSchema and WORKFLOW.md.
 * Returns undefined when defaultTier is absent/invalid (=> no routing).
 */
export declare function parseModelRouting(raw: unknown): ModelRoutingConfig | undefined;
//# sourceMappingURL=model-routing.d.ts.map