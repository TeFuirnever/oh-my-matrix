"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureGoal = captureGoal;
exports.preserveGoalBeforeCompaction = preserveGoalBeforeCompaction;
exports.restoreGoalAfterCompaction = restoreGoalAfterCompaction;
const autopilot_state_1 = require("./autopilot-state");
function captureGoal(state, userMessage) {
    if (!state.enabled || !userMessage.trim())
        return state;
    return (0, autopilot_state_1.setGoal)(state, userMessage.trim());
}
function preserveGoalBeforeCompaction(state) {
    if (!state.enabled || !state.goal)
        return state;
    return (0, autopilot_state_1.snapshotGoal)(state);
}
function restoreGoalAfterCompaction(state) {
    if (!state.enabled)
        return state;
    return (0, autopilot_state_1.restoreGoalFromSnapshot)(state);
}
//# sourceMappingURL=goal-manager.js.map