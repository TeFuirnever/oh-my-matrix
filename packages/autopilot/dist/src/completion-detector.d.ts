export declare function isTaskComplete(lastAssistantMessage?: string, stopHookActive?: boolean): boolean;
/**
 * Detect when the model's response signals there is NO actionable task — it
 * greeted the user and asked what to do, requested a concrete task, or stated
 * outright that nothing can be acted on.
 *
 * `decideContinuation` uses this to stop the autonomous loop gracefully on
 * non-task inputs (greetings like "你好", chit-chat, single-word messages)
 * instead of burning the entire continuation budget looping "continue from
 * where you left off" on a message that has nothing to act on.
 *
 * HIGH-PRECISION patterns only — a match triggers an immediate `complete`, so
 * these must not fire during genuine task progress. We deliberately scope to:
 *   (1) greeting-style help offers ("有什么可以帮你的吗" / "how can I help"),
 *   (2) the model asking the user for direction ("请问需要我做什么"),
 *   (3) explicit "no task" statements ("没有具体的任务" / "there is no task").
 * Generic mid-task clarification requests ("please provide more details about
 * the API") are intentionally NOT matched — they are too close to normal work.
 */
export declare function hasNoActionableTask(lastAssistantMessage?: string): boolean;
//# sourceMappingURL=completion-detector.d.ts.map