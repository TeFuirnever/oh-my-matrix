"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEffortInjection = buildEffortInjection;
/**
 * Effort injection for autopilot agent_turn_prepare hook.
 *
 * When autopilot status is 'running', injects a context instruction
 * to ensure the model uses high effort (extended thinking) for each turn.
 * This prevents cross-turn effort degradation (TD-1).
 */
function buildEffortInjection(status) {
    if (status === 'running') {
        return '[autopilot-effort] Use high effort (extended thinking) for this turn.';
    }
    return null;
}
//# sourceMappingURL=effort-injection.js.map