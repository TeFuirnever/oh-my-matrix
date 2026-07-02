export function isTaskComplete(
  lastAssistantMessage?: string,
  stopHookActive?: boolean,
): boolean {
  if (stopHookActive) return false;
  if (!lastAssistantMessage?.trim()) return false;

  // Strip code blocks and inline code to avoid false positives
  const stripped = lastAssistantMessage
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');

  const lower = stripped.toLowerCase();

  // Chinese: match after sentence boundary (punctuation, newline, or start).
  // X-13: include \r so CRLF (\r\n) and lone CR boundaries match — Windows
  // agents commonly emit \r\n line endings and a bare \r would otherwise
  // prevent the trigger from firing.
  const boundary = '(^|[。！？\\r\\n，,；;：:])';
  // Negation guard: a completion phrase trailed by an explicit turn/residual word
  // (但/还需/尚未…) is conditional, not a real completion ("所有任务已完成，但还需验证").
  // Kept deliberately narrow — ambiguous words like 待 ("待处理" appears in genuine
  // completions: "所有任务已完成，没有更多待处理的事项") or 需要 must NOT be here.
  const zhConditional = /(?:所有任务已完成|任务全部完成|全部步骤已完成)[^。！？\n]{0,15}(?:但|不过|然而|还需|仍需|尚需|尚未|还要|仍要)/;
  if (!zhConditional.test(stripped)) {
    if (new RegExp(`${boundary}\\s*所有任务已完成`).test(lower)) return true;
    if (new RegExp(`${boundary}\\s*任务全部完成`).test(lower)) return true;
    if (new RegExp(`${boundary}\\s*全部步骤已完成`).test(lower)) return true;
  }

  // English: word-boundary + negation guard
  if (/\ball\s+tasks\s+(?:have\s+)?been\s+completed\b/.test(lower)) return true;
  if (/\ball\s+tasks\s+completed\b/.test(lower) && !/\bnot\s+all\s+tasks\b/.test(lower)) return true;
  if (/\ball\s+steps\s+(?:have\s+)?been\s+completed\b/.test(lower)) return true;
  if (/\ball\s+steps\s+completed\b/.test(lower) && !/\bnot\s+all\s+steps\b/.test(lower)) return true;
  if (/\b(?:the\s+)?(?:task|implementation|feature|work)\s+is\s+complete\b/.test(lower) && !/\bnot\s+(?:yet\s+)?complete\b/.test(lower)) return true;
  if (/\beverything\s+is\s+done\b/.test(lower) && !/\bnot\s+everything\b/.test(lower)) return true;

  return false;
}

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
export function hasNoActionableTask(lastAssistantMessage?: string): boolean {
  if (!lastAssistantMessage?.trim()) return false;

  // Strip code blocks and inline code — same guard as isTaskComplete, so a
  // no-task phrase embedded in a code sample does not falsely stop the run.
  const stripped = lastAssistantMessage
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
  const lower = stripped.toLowerCase();

  // ─── Chinese ──────────────────────────────────────────────
  // (1) Greeting help-offer. The trailing 帮 anchor prevents mid-task phrases
  //     like "有什么可以优化的" (what can be optimized) from matching.
  if (/有什么.{0,6}(?:可以|能).{0,4}帮/.test(stripped)) return true;
  // (2) Asking the user for direction ("请问需要我做什么 / 帮忙 / 效劳").
  if (/请问.{0,8}(?:需要|想要|希望).{0,6}我.{0,6}(?:做|帮|效劳)/.test(stripped)) return true;
  // (3) Request for a concrete task ("请告诉我具体的需求/任务").
  if (/请(?:告诉我|提供|说明).{0,10}(?:具体|详细|明确).{0,4}(?:任务|需求|要求)/.test(stripped)) return true;
  // (4) Explicit no-task. The (具体|明确|实际) qualifier is REQUIRED so that
  //     "还没有完成任务" / "没完成任务" (incomplete-but-working) does NOT match.
  if (/(?:目前|现在|当前)?没有.{0,4}(?:具体|明确|实际).{0,2}(?:任务|需求)/.test(stripped)) return true;

  // ─── English ──────────────────────────────────────────────
  // (1) Greeting help-offer.
  if (/how can i help/.test(lower)) return true;
  if (/what can i do for you/.test(lower)) return true;
  if (/is there (?:anything|something) i can (?:help|do)/.test(lower)) return true;
  // (2) Asking the user for direction.
  if (/what (?:would|do) you (?:like|want|need) me to do/.test(lower)) return true;
  // (3) Explicit no-task. "task|thing" only (NOT "work") so "I don't have the
  //     workaround" cannot match on the "work" substring.
  // ponytail: negative lookahead blocks past-participles that flip meaning ("task finished" ≠ "no task")
  if (/i (?:don't|do not) (?:have|see).{0,15}\b(?:task|thing)\b(?!\s+(?:finish|done|complet|work|ready|start|remain|left|assign))/i.test(lower)) return true;
  if (/there(?:'s| is| are) no (?:actionable |specific |concrete )?(?:task|tasks|work)/.test(lower)) return true;
  if (/nothing to (?:do|work on|implement|execute)/.test(lower)) return true;

  return false;
}
