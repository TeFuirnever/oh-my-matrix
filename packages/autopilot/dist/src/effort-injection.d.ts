/**
 * Effort injection for autopilot agent_turn_prepare hook.
 *
 * When autopilot status is 'running', injects a context instruction
 * calibrated to the requested thinking intensity level.
 * This prevents cross-turn effort degradation (TD-1).
 */
import type { ThinkingIntensity, EvidenceStatus } from './types';
/**
 * Build the effort-injection context line for the current turn.
 * Returns null when autopilot is not running (no injection).
 * Default intensity 'high' preserves the pre-graduation behaviour.
 */
export declare function buildEffortInjection(status: string, intensity?: ThinkingIntensity): string | null;
/**
 * Resolve thinking intensity dynamically based on execution phase.
 *
 * Phase detection heuristic:
 * - evidence.status === 'running': validation phase -> low (fast execution)
 * - totalContinuations <= 1: initial turns -> high (deep analysis)
 * - otherwise: use the configured static intensity
 *
 * Note: totalContinuations === 0 is the first execution turn (user prompt
 * arrives, agent starts working). Autopilot has NO dedicated "planning phase"
 * — these are "initial turns", not "planning turns".
 */
export declare function resolveThinkingIntensity(totalContinuations: number, evidenceStatus: EvidenceStatus | undefined, configIntensity?: ThinkingIntensity): ThinkingIntensity;
//# sourceMappingURL=effort-injection.d.ts.map