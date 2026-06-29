import type { AutopilotState } from './src/types';
import type { OpenClawPluginApi } from 'openclaw/dist/plugin-sdk/plugin-runtime';
export type { AutopilotProjection } from './src/projection';
export declare const id = "autopilot";
export declare const name = "Autopilot Continuous Mode";
export declare const version = "2.0.0";
export declare function _resetForTest(): void;
/** Test-only: inject a mock audit_setMode so the closed-over _auditSetMode reference is replaceable. */
export declare function _setAuditSetModeForTest(fn: ((mode: 'active' | 'monitor' | 'passive') => void) | null): void;
export declare function _getInternalStateForTest(): {
    stateByRunSize: number;
    sessionIdToKeySize: number;
    sessionKeyToRunIdSize: number;
    canaryFiredSize: number;
};
/**
 * Test helper: inject a partial state for a session and immediately run the
 * retry_due check logic, returning the resulting state.
 * Only available in test environments — do NOT call from production code.
 */
export declare function _triggerRetryCheckForTest(overrides: {
    sessionKey: string;
    orchestrationState: AutopilotState['orchestrationState'];
    retry?: AutopilotState['retry'];
}): AutopilotState | undefined;
/** Generate a unique run ID using crypto.randomUUID (exported for testing). */
export declare function _generateRunIdForTest(): string;
export declare function register(api: OpenClawPluginApi): void;
//# sourceMappingURL=index.d.ts.map