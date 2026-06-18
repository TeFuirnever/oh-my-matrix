import type { AutopilotState, ContinuationDecision } from './types';
interface FinalizeEvent {
    lastAssistantMessage?: string;
    stopHookActive?: boolean;
}
export declare function decideContinuation(state: AutopilotState, event: FinalizeEvent): ContinuationDecision;
export declare function buildRetryInstruction(state: AutopilotState): string;
export {};
//# sourceMappingURL=continuation-engine.d.ts.map