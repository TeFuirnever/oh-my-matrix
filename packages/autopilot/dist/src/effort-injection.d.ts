/**
 * Effort injection for autopilot agent_turn_prepare hook.
 *
 * When autopilot status is 'running', injects a context instruction
 * to ensure the model uses high effort (extended thinking) for each turn.
 * This prevents cross-turn effort degradation (TD-1).
 */
export declare function buildEffortInjection(status: string): string | null;
//# sourceMappingURL=effort-injection.d.ts.map