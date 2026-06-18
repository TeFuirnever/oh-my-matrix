"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkStall = checkStall;
/**
 * Check if the run has stalled based on last activity time.
 * Only considers stall when orchestrationState is 'running'.
 */
function checkStall(input) {
    const { orchestrationState, lastActivityAt, now, stallTimeoutMs } = input;
    // Only check stall while actively running
    if (orchestrationState !== 'running') {
        return { stalled: false };
    }
    if (lastActivityAt == null) {
        return { stalled: false };
    }
    const elapsed = now - lastActivityAt;
    if (elapsed > stallTimeoutMs) {
        return {
            stalled: true,
            stallDurationMs: elapsed - stallTimeoutMs,
        };
    }
    return { stalled: false };
}
//# sourceMappingURL=stall-detector.js.map