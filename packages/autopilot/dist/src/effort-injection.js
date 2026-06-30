"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEffortInjection = buildEffortInjection;
exports.resolveThinkingIntensity = resolveThinkingIntensity;
/**
 * Build the effort-injection context line for the current turn.
 * Returns null when autopilot is not running (no injection).
 * Default intensity 'high' preserves the pre-graduation behaviour.
 */
function buildEffortInjection(status, intensity = 'high') {
    if (status !== 'running')
        return null;
    switch (intensity) {
        case 'low':
            return '[autopilot-effort] Use standard effort for this turn. Prefer direct, efficient responses.';
        case 'medium':
            return '[autopilot-effort] Use moderate effort (some extended thinking) for this turn.';
        case 'high':
            return '[autopilot-effort] Use high effort (extended thinking) for this turn.';
    }
}
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
function resolveThinkingIntensity(totalContinuations, evidenceStatus, configIntensity = 'high') {
    if (evidenceStatus === 'running')
        return 'low';
    if (totalContinuations <= 1)
        return 'high';
    return configIntensity;
}
//# sourceMappingURL=effort-injection.js.map