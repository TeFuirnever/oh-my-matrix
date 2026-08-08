/**
 * E2: pure cost calculation + cap detection, shared by projection (observability),
 * the 60s patrol (primary cap enforcer, index.ts) and the finalize-time fast
 * path (continuation-engine.ts). Extracted from projection.ts / index.ts so the
 * cap path and the projection can't drift to two pricing constants, and so the
 * finalize fast-path doesn't re-implement the detector.
 *
 * Pricing is Claude Sonnet (as of 2026-Q2). Update both call sites by editing
 * these constants. Source: https://www.anthropic.com/pricing
 */
import type { AutopilotState, PauseReason } from './types';

export const AUTOPILOT_INPUT_COST_PER_M_USD = 3.0;
export const AUTOPILOT_OUTPUT_COST_PER_M_USD = 15.0;

/**
 * Estimated USD cost for a token spend. Pure function of input/output token
 * counts; returns 0 for absent/invalid counts (NaN/negative → treated as 0, so
 * a malformed usage report can't trip a cost cap spuriously).
 */
export function computeCostUsd(inputTokens: number, outputTokens: number): number {
  const input = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0;
  const output = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0;
  return (input * AUTOPILOT_INPUT_COST_PER_M_USD + output * AUTOPILOT_OUTPUT_COST_PER_M_USD) / 1_000_000;
}

/**
 * E2: cost cap only (no clock). Used by the finalize-time fast-path, which must
 * stay pure. Returns the PauseReason when the cost cap is exceeded, else null.
 * No-op when maxCostUsd is unset/<=0 (0 is treated as "disabled", not "stop
 * instantly" — a common sentinel) OR the host hasn't reported usage (tokens 0).
 */
export function detectCostCap(state: AutopilotState): PauseReason | null {
  if (state.maxCostUsd != null && state.maxCostUsd > 0) {
    const cost = computeCostUsd(state.inputTokensUsed ?? 0, state.outputTokensUsed ?? 0);
    if (cost >= state.maxCostUsd) return 'max_cost_reached';
  }
  return null;
}

/**
 * E2: detect whether a run has exceeded a hard cap (wall-clock and/or cost).
 * Pure function of state + now; duration is checked first, then cost. Returns
 * the first exceeded cap's reason, or null. maxDurationMs<=0 is treated as
 * "disabled" (same 0-sentinel rule as cost). The 60s patrol is the production
 * caller (it can also reach retry_queued, which the finalize path cannot).
 */
export function detectCapExceeded(state: AutopilotState, now: number): { reason: PauseReason } | null {
  if (state.maxDurationMs != null && state.maxDurationMs > 0 && state.startedAt != null && now - state.startedAt >= state.maxDurationMs) {
    return { reason: 'max_duration_reached' };
  }
  const costCap = detectCostCap(state);
  return costCap ? { reason: costCap } : null;
}

