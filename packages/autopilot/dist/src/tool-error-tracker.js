"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackToolError = trackToolError;
exports.isThresholdExceeded = isThresholdExceeded;
function trackToolError(state, error) {
    const isSameError = state.lastToolError &&
        state.lastToolError.tool === error.tool &&
        state.lastToolError.args === error.args;
    return {
        ...state,
        lastToolError: error,
        toolErrorCount: isSameError ? state.toolErrorCount + 1 : 1,
    };
}
function isThresholdExceeded(state, threshold) {
    return state.toolErrorCount >= threshold;
}
//# sourceMappingURL=tool-error-tracker.js.map